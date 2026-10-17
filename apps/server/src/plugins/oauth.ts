/**
 * Google OAuth core for plugin connections.
 *
 * Credentials (client ID/secret) come from plugins.json (oauthClients.google),
 * not .env. The daemon host is the trust boundary; tokens are stored
 * server-side only (plugins.json + the connection row's status).
 */
import type { Config } from "../config";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export interface OAuthDeps {
  config: Config;
  clientID: string;
  clientSecret: string;
  /** JSON fetcher injected for tests; production uses global fetch. */
  fetch?: typeof fetch;
}

export interface TokenSet {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}

export function isConfigured(deps: Pick<OAuthDeps, "clientID" | "clientSecret">): boolean {
  return Boolean(deps.clientID && deps.clientSecret);
}

/** The redirect URI Google must have registered as `http://127.0.0.1:<port>/oauth/callback`. */
export function redirectURI(config: Config, port = config.port): string {
  return `http://127.0.0.1:${port}/oauth/callback`;
}

export function authorizeURL(deps: OAuthDeps, config: Config, scopes: string[], state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", deps.clientID);
  url.searchParams.set("redirect_uri", redirectURI(config));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(deps: OAuthDeps, config: Config, code: string): Promise<TokenSet> {
  const response = await (deps.fetch ?? fetch)(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: deps.clientID,
      client_secret: deps.clientSecret,
      redirect_uri: redirectURI(config),
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(body.error_description ?? `token exchange failed (${response.status})`);
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  return {
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    ...(data.access_token ? { access_token: data.access_token } : {}),
    ...(data.expires_in ? { expires_at: Date.now() + data.expires_in * 1000 } : {}),
  };
}

export async function refresh(
  deps: OAuthDeps,
  refreshToken: string,
): Promise<TokenSet> {
  const response = await (deps.fetch ?? fetch)(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.clientID,
      client_secret: deps.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(body.error_description ?? `token refresh failed (${response.status})`);
  }
  const data = (await response.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!data.access_token) throw new Error("token refresh returned no access token");
  return {
    access_token: data.access_token,
    ...(data.expires_in ? { expires_at: Date.now() + data.expires_in * 1000 } : {}),
  };
}

export async function revoke(deps: OAuthDeps, token: string): Promise<boolean> {
  const response = await (deps.fetch ?? fetch)(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  return response.ok;
}

export async function whoami(
  deps: OAuthDeps,
  accessToken: string,
): Promise<{ email?: string }> {
  const response = await (deps.fetch ?? fetch)(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return {};
  const data = (await response.json().catch(() => ({}))) as { email?: string };
  return { email: data.email };
}

export async function ensureAccessToken(
  deps: OAuthDeps,
  tokens: { access_token?: string; refresh_token?: string; expires_at?: number },
): Promise<string> {
  if (tokens.access_token && tokens.expires_at && tokens.expires_at - 60_000 > Date.now()) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new Error("no refresh token stored — reconnect the plugin");
  const fresh = await refresh(deps, tokens.refresh_token);
  return fresh.access_token!;
}