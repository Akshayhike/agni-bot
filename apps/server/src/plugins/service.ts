/**
 * Plugin service: the logic behind the `plugin.*` frames and the OAuth
 * callback route. Holds the catalog's frame-facing truth (every catalog row
 * becomes a PluginInfo), runs connect/disconnect, and emits `plugin.state`
 * snapshots to every client whenever a connection changes.
 */
import type { Database } from "bun:sqlite";
import type { PluginAccount, PluginInfo, PluginStatus, ServerFrameBody } from "@agni/protocol";
import type { Config } from "../config";
import { CATALOG, manifestFor, type PluginManifest } from "./catalog";
import * as oauth from "./oauth";
import {
  completeConnect,
  deleteConnection,
  getConnection,
  getConnectionByState,
  getConnectionFor,
  getConnections,
  markError,
  startPending,
  type PluginConnectionRow,
  type TokenBlob,
  updateTokens,
} from "./store";

export interface PluginDeps {
  config: Config;
  db: Database;
  /** Fan out to every authed session (the `plugin.state` snapshot). */
  emit: (body: ServerFrameBody) => void;
}

export class PluginService {
  private deps: PluginDeps;
  /** Test hook: injected fetch for Google endpoints. */
  fetchOverride?: typeof fetch;

  constructor(deps: PluginDeps) {
    this.deps = deps;
  }

  private oauthDeps(): oauth.OAuthDeps {
    return { config: this.deps.config, ...(this.fetchOverride ? { fetch: this.fetchOverride } : {}) };
  }

  /** The full settings-pane snapshot: every catalog row, live status merged in. */
  list(): PluginInfo[] {
    const connections = getConnections(this.deps.db);
    const infos: PluginInfo[] = [];
    for (const manifest of CATALOG) {
      for (const role of manifest.roles) {
        const row = connections.find((entry) => entry.plugin_id === manifest.id && entry.account === role.account);
        infos.push(toInfo(manifest, role.account, row));
      }
    }
    // A connection row whose manifest moved on (catalog edited) still shows —
    // as an error, never silently missing.
    for (const row of connections) {
      if (infos.some((info) => info.id === row.plugin_id && info.account === row.account)) continue;
      infos.push({
        id: row.plugin_id,
        name: row.plugin_id,
        category: "mcp",
        description: "This plugin is no longer in the catalog; disconnect it to clean up.",
        authKind: "mcp",
        account: row.account,
        scopes: [],
        capabilities: [],
        available: false,
        connectionID: row.id,
        status: row.status as PluginStatus,
        ...(row.account_label ? { accountLabel: row.account_label } : {}),
        ...(row.error ? { error: row.error } : {}),
      });
    }
    return infos;
  }

  /** Begin a connect flow; answers the authorize URL for the browser, or an error. */
  connect(pluginID: string, account: PluginAccount): { authorizeURL?: string; error?: { code: string; message: string } } {
    const manifest = manifestFor(pluginID);
    if (!manifest) return { error: { code: "unknown_plugin", message: `no plugin "${pluginID}" in the catalog` } };
    const role = manifest.roles.find((entry) => entry.account === account);
    if (!role) {
      return { error: { code: "unknown_plugin", message: `plugin "${pluginID}" does not offer an ${account} connection` } };
    }

    // App-password plugins: credentials come from .env, not OAuth.
    if (manifest.authKind === "app-password") {
      const user = this.appPasswordUser(pluginID, account);
      const pass = this.appPassword(pluginID, account);
      if (!user || !pass) {
        return {
          error: {
            code: "plugin_not_configured",
            message: `Set GMAIL_USER and GMAIL_APP_PASSWORD in .env (and restart the daemon) to connect this mailbox.`,
          },
        };
      }
      try {
        const pending = startPending(this.deps.db, {
          pluginID,
          account,
          scopes: [],
          capabilities: role.capabilities,
        });
        // Mark connected immediately — credentials are already in .env.
        // (A real IMAP verify lands with the Gmail plugin in PS3.)
        completeConnect(this.deps.db, pending.id, { access_token: pass }, user);
        this.emitState();
        return {}; // no authorize URL needed
      } catch (error) {
        return { error: { code: "plugin_connect_failed", message: error instanceof Error ? error.message : String(error) } };
      }
    }

    // API-key plugins (Firecrawl): key or URL from .env.
    if (manifest.authKind === "api-key") {
      const url = this.deps.config.firecrawlURL;
      const key = this.deps.config.firecrawlAPIKey;
      if (!url && !key) {
        return {
          error: {
            code: "plugin_not_configured",
            message: `Set AGNI_FIRECRAWL_URL (self-hosted) or AGNI_FIRECRAWL_API_KEY (cloud) in .env and restart the daemon.`,
          },
        };
      }
      try {
        const label = url ? `self-hosted (${url})` : "cloud";
        const pending = startPending(this.deps.db, {
          pluginID,
          account,
          scopes: [],
          capabilities: role.capabilities,
        });
        completeConnect(this.deps.db, pending.id, { access_token: key || "self-hosted" }, label);
        this.emitState();
        return {};
      } catch (error) {
        return { error: { code: "plugin_connect_failed", message: error instanceof Error ? error.message : String(error) } };
      }
    }

    if (manifest.authKind !== "oauth") {
      return {
        error: {
          code: "plugin_unavailable",
          message: `${manifest.name} connects via MCP and is not wired yet (lands with the MCP plugin pass)`,
        },
      };
    }
    if (!oauth.isConfigured(this.deps.config)) {
      return {
        error: { code: "plugin_not_configured", message: "set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first" },
      };
    }

    try {
      const pending = startPending(this.deps.db, {
        pluginID,
        account,
        scopes: role.scopes,
        capabilities: role.capabilities,
      });
      this.emitState();
      const tokens = readTokens(pending);
      return { authorizeURL: oauth.authorizeURL(this.deps.config, role.scopes, tokens.state ?? "") };
    } catch (error) {
      return { error: { code: "plugin_connect_failed", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  /** The loopback route's landing: finish the grant for whichever state this is. */
  async completeSignIn(state: string, code: string): Promise<{ plugin?: string; error?: string }> {
    const pending = getConnectionByState(this.deps.db, state);
    if (!pending) {
      return { error: "This sign-in is stale or was already completed. Connect again from the settings pane." };
    }
    try {
      const tokens = await oauth.exchangeCode(this.oauthDeps(), code);
      if (!tokens.access_token) throw new Error("Google returned no access token");
      const { email } = await oauth.whoami(this.oauthDeps(), tokens.access_token);
      completeConnect(this.deps.db, pending.id, tokens, email ?? "Google account");
      this.emitState();
      return { plugin: pending.plugin_id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markError(this.deps.db, pending.id, message);
      this.emitState();
      return { error: message };
    }
  }

  /** Disconnect: revoke with Google, then drop the row so a re-connect starts clean. */
  async disconnect(connectionID: string): Promise<{ error?: { code: string; message: string } }> {
    const row = getConnection(this.deps.db, connectionID);
    if (!row) return { error: { code: "unknown_connection", message: `no connection ${connectionID}` } };
    const tokens = readTokens(row);
    try {
      const target = tokens.refresh_token ?? tokens.access_token;
      if (target) await oauth.revoke(this.oauthDeps(), target);
    } catch {
      // A Google-side failure must not strand the credential locally: the
      // row delete below is what actually destroys it server-side.
    }
    deleteConnection(this.deps.db, row.id);
    this.emitState();
    return {};
  }

  /** A stored, still-valid access token for API clients (PS3+). */
  async accessTokenFor(pluginID: string, account: PluginAccount): Promise<string> {
    const row = getConnectionFor(this.deps.db, pluginID, account);
    if (!row || row.status !== "connected") throw new Error(`plugin ${pluginID}/${account} is not connected`);
    const tokens = readTokens(row);
    const token = await oauth.ensureAccessToken(this.oauthDeps(), tokens);
    // Persist the fresh access token so the next turn does not redo the exchange.
    if (tokens.access_token !== token) {
      updateTokens(this.deps.db, row.id, { ...tokens, access_token: token });
    }
    return token;
  }

  /** Auto-connect app-password and api-key plugins from .env on daemon start. */
  autoConnect(): void {
    for (const manifest of CATALOG) {
      if (manifest.authKind !== "app-password" && manifest.authKind !== "api-key") continue;
      for (const role of manifest.roles) {
        let user = "";
        let pass = "";
        if (manifest.authKind === "app-password") {
          user = this.appPasswordUser(manifest.id, role.account);
          pass = this.appPassword(manifest.id, role.account);
        } else if (manifest.authKind === "api-key") {
          user = this.deps.config.firecrawlURL || "cloud";
          pass = this.deps.config.firecrawlAPIKey || "self-hosted";
        }
        if (!user || !pass) continue;
        const existing = getConnectionFor(this.deps.db, manifest.id, role.account);
        if (existing?.status === "connected") continue;
        try {
          const pending = startPending(this.deps.db, {
            pluginID: manifest.id,
            account: role.account,
            scopes: [],
            capabilities: role.capabilities,
          });
          completeConnect(this.deps.db, pending.id, { access_token: pass }, user);
        } catch {
          // Non-fatal: the plugin shows as disconnected.
        }
      }
    }
    this.emitState();
  }

  private emitState(): void {
    this.deps.emit({ type: "plugin.state", plugins: this.list() });
  }

  private appPasswordUser(pluginID: string, account: PluginAccount): string {
    if (account === "agent") return this.deps.config.gmailUser;
    return this.deps.config.gmailOwnerUser ?? "";
  }

  private appPassword(pluginID: string, account: PluginAccount): string {
    if (account === "agent") return this.deps.config.gmailAppPassword;
    return this.deps.config.gmailOwnerAppPassword ?? "";
  }
}

function readTokens(row: PluginConnectionRow): TokenBlob {
  if (!row.tokens) return {};
  try {
    return JSON.parse(row.tokens) as TokenBlob;
  } catch {
    return {};
  }
}

function toInfo(manifest: PluginManifest, account: PluginAccount, row?: PluginConnectionRow): PluginInfo {
  const role = manifest.roles.find((entry) => entry.account === account)!;
  return {
    id: manifest.id,
    name: manifest.name,
    category: manifest.category,
    description: manifest.description,
    authKind: manifest.authKind,
    account,
    scopes: role.scopes,
    capabilities: role.capabilities,
    // OAuth kinds are reachable once the daemon has Google creds configured.
    available: manifest.authKind === "oauth" || manifest.authKind === "app-password" || manifest.authKind === "api-key",
    ...(row?.id ? { connectionID: row.id } : {}),
    ...(row?.status ? { status: row.status as PluginStatus } : {}),
    ...(row?.account_label ? { accountLabel: row.account_label } : {}),
    ...(row?.error ? { error: row.error } : {}),
    ...(row?.connected_at ? { connectedAt: row.connected_at } : {}),
  };
}
