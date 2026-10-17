/**
 * Google OAuth core for plugin connections.
 *
 * Strategy: desktop-flow OAuth against Google's endpoints with a loopback
 * redirect (`http://127.0.0.1:<port>/oauth/callback`) that the daemon itself
 * serves. The Cloud project is published as "In production, unverified" —
 * that is the documented way to get refresh tokens that do not expire every
 * 7 days (the Testing-status expiry), with no 2FA or app-password involved.
 * See docs/plugins-plan.html §3 for the decision.
 *
 * Tokens are stored server-side only (plugin_connections.tokens); nothing
 * that carries them ever leaves the daemon.
 */
import type { Config } from "../config";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export interface OAuthDeps {
  config: Config;
  /** JSON fetcher injected for tests; production uses global fetch. */
  fetch?: typeof fetch;
}

export interface TokenSet {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}

export function isConfigured(config: Config): boolean {
  return Boolean(config.googleOAuthClientID && config.googleOAuthClientSecret);
}

/** The redirect URI Google must have registered as `http://127.0.0.1:<port>/oauth/callback`. */
export function redirectURI(config: Config, port = config.port): string {
  return `http://127.0.0.1:${port}/oauth/callback`;
}

export function authorizeURL(config: Config, scopes: string[], state: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.googleOAuthClientID);
  url.searchParams.set("redirect_uri", redirectURI(config));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  // Refresh tokens are the whole point: offline access + forced-consent keeps
  // Google issuing one even after a previous grant.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
}

export async function exchangeCode(deps: OAuthDeps, code: string): Promise<TokenSet> {
  const response = await (deps.fetch ?? fetch)(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: deps.config.googleOAuthClientID,
      client_secret: deps.config.googleOAuthClientSecret,
      redirect_uri: redirectURI(deps.config),
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(body.error_description ?? `token exchange failed (${response.status})`);
  }
  const data = (await response.json()) as TokenResponse;
  return {
    ...(data.refresh_token ? { refresh_token: data.refresh_token } : {}),
    ...(data.access_token ? { access_token: data.access_token } : {}),
    ...(data.expires_in ? { expires_at: Date.now() + data.expires_in * 1000 } : {}),
  };
}

/**
 * Lazily mint a fresh access token from the stored refresh token. Called by
 * API clients (PS3+) just before a Google call; no background daemon —
 * something that never stays idle never needs scheduled refreshing.
 */
export async function refresh(
  deps: OAuthDeps,
  refreshToken: string,
): Promise<TokenSet> {
  const response = await (deps.fetch ?? fetch)(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: deps.config.googleOAuthClientID,
      client_secret: deps.config.googleOAuthClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error_description?: string };
    throw new Error(body.error_description ?? `token refresh failed (${response.status})`);
  }
  const data = (await response.json()) as TokenResponse;
  if (!data.access_token) throw new Error("token refresh returned no access token");
  return {
    access_token: data.access_token,
    ...(data.expires_in ? { expires_at: Date.now() + data.expires_in * 1000 } : {}),
  };
}

/** Tell Google to forget the grant, then callers drop the row. */
export async function revoke(deps: OAuthDeps, token: string): Promise<boolean> {
  const response = await (deps.fetch ?? fetch)(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  return response.ok;
}

/** The signed-in email, for the connection row's display label. */
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

/** Pull an unexpired access token when possible, refreshing otherwise. */
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
