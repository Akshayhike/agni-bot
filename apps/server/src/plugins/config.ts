/**
 * plugins.json — the single source of truth for plugin auth, tokens, and
 * activation state. Replaces plugin credentials in .env: the daemon reads
 * this file on startup, and the agent can manage its own plugins here in the
 * future (plugin.create / plugin.configure tools).
 *
 * File location: data/plugins.json (gitignored, server-side only).
 *
 * Schema:
 * {
 *   "version": 1,
 *   "plugins": {
 *     "<pluginID>": {
 *       "account": "agent" | "owner",
 *       "enabled": true,
 *       "auth": { ... }   // kind-specific credentials
 *     }
 *   }
 * }
 *
 * Auth kinds:
 *   app-password: { kind, user, pass }
 *   api-key:       { kind, key?, url? }        // key = cloud API key, url = self-hosted
 *   oauth:         { kind, refresh_token?, access_token?, expires_at? }
 *   mcp:           { kind }                     // browser OAuth, no stored creds
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface PluginAuth {
  kind: "app-password" | "api-key" | "oauth" | "mcp";
  // app-password
  user?: string;
  pass?: string;
  // api-key
  key?: string;
  url?: string;
  // oauth
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}

export interface PluginEntry {
  account: "agent" | "owner";
  enabled: boolean;
  auth: PluginAuth;
  /** Display label (e.g. the signed-in email), set at connect time. */
  label?: string;
  /** Epoch ms of the last successful connect. */
  connectedAt?: number;
}

export interface OAuthClient {
  clientID: string;
  clientSecret: string;
}

export interface PluginsFile {
  version: number;
  /** OAuth client credentials keyed by provider (e.g. "google"). */
  oauthClients?: Record<string, OAuthClient>;
  plugins: Record<string, PluginEntry>;
}

export function emptyPluginsFile(): PluginsFile {
  return { version: 1, plugins: {} };
}

export function loadPluginsFile(path: string): PluginsFile {
  if (!existsSync(path)) return emptyPluginsFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PluginsFile;
    if (parsed.version !== 1 || typeof parsed.plugins !== "object") return emptyPluginsFile();
    return parsed;
  } catch {
    return emptyPluginsFile();
  }
}

export function savePluginsFile(path: string, config: PluginsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function getPluginEntry(config: PluginsFile, pluginID: string): PluginEntry | undefined {
  return config.plugins[pluginID];
}

export function isPluginEnabled(config: PluginsFile, pluginID: string): boolean {
  return config.plugins[pluginID]?.enabled ?? false;
}

/** Merge a plugin entry into the config (create or update). */
export function upsertPlugin(config: PluginsFile, pluginID: string, entry: PluginEntry): void {
  config.plugins[pluginID] = entry;
}

export function removePlugin(config: PluginsFile, pluginID: string): void {
  delete config.plugins[pluginID];
}

/** All plugin IDs that are enabled, for auto-connect on daemon start. */
export function enabledPluginIDs(config: PluginsFile): string[] {
  return Object.entries(config.plugins)
    .filter(([, entry]) => entry.enabled)
    .map(([id]) => id);
}