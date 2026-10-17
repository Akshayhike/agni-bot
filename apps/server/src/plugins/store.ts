/**
 * The plugin connection store: one durable row per catalog plugin bound to
 * one account. Tokens stay here, server-side only — clients never receive
 * them; the frame snapshot carries status, scopes, and policy, never secrets.
 */
import type { Database } from "bun:sqlite";
import type { PluginAccount } from "@agni/protocol";
import { newID, nowISO } from "../util/ids";

export interface PluginConnectionRow {
  id: string;
  plugin_id: string;
  account: PluginAccount;
  status: "disconnected" | "pending" | "connected" | "error";
  account_label: string | null;
  scopes: string | null; // JSON array actually granted
  capabilities: string | null; // JSON policy snapshot at connect time
  tokens: string | null; // JSON TokenBlob — server-side only
  error: string | null;
  grant_started_at: string | null;
  connected_at: string | null;
  updated_at: string;
}

/** What lives in the `tokens` column. `state` survives a daemon restart mid-auth. */
export interface TokenBlob {
  state?: string;
  refresh_token?: string;
  access_token?: string;
  /** Epoch ms after which the access token needs a refresh. */
  expires_at?: number;
}

function parseTokens(row: PluginConnectionRow): TokenBlob {
  if (!row.tokens) return {};
  try {
    return JSON.parse(row.tokens) as TokenBlob;
  } catch {
    return {};
  }
}

export function getConnections(db: Database): PluginConnectionRow[] {
  return db.query<PluginConnectionRow, []>("SELECT * FROM plugin_connections").all();
}

export function getConnection(db: Database, id: string): PluginConnectionRow | null {
  return db.query<PluginConnectionRow, [string]>("SELECT * FROM plugin_connections WHERE id = ?").get(id) ?? null;
}

export function getConnectionFor(db: Database, pluginID: string, account: PluginAccount): PluginConnectionRow | null {
  return db
    .query<PluginConnectionRow, [string, string]>("SELECT * FROM plugin_connections WHERE plugin_id = ? AND account = ?")
    .get(pluginID, account) ?? null;
}

/** Find a pending row by OAuth state (survives daemon restarts mid-flow). */
export function getConnectionByState(db: Database, state: string): PluginConnectionRow | null {
  const rows = db
    .query<PluginConnectionRow, [string]>("SELECT * FROM plugin_connections WHERE status = 'pending' AND tokens LIKE ?")
    .all(`%"state":"${state}"%`);
  // A LIKE can over-match; the exact check seals it.
  return rows.find((row) => parseTokens(row).state === state) ?? null;
}

export interface ConnectPatch {
  connectionID?: string;
  pluginID: string;
  account: PluginAccount;
  scopes: string[]; // catalog scopes requested at this connect
  capabilities: unknown; // policy snapshot
  /** Caller-supplied state for the pending OAuth flow; minted when absent. */
  state?: string;
}

/**
 * Create-or-reset the (plugin, account) connection as a fresh pending grant.
 * A previous pending row for the same pair is cleared, and a previous
 * connected grant's tokens are wiped — a re-connect always starts clean.
 */
export function startPending(db: Database, patch: ConnectPatch): PluginConnectionRow {
  const existing = getConnectionFor(db, patch.pluginID, patch.account);
  const id = existing?.id ?? newID("plc");
  const state = patch.state ?? `st_${crypto.randomUUID()}`;
  const now = nowISO();
  db.run(
    `INSERT INTO plugin_connections
       (id, plugin_id, account, status, account_label, scopes, capabilities, tokens,
        error, grant_started_at, connected_at, updated_at)
     VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, ?, NULL, ?)
     ON CONFLICT(plugin_id, account) DO UPDATE SET
       status = 'pending',
       account_label = NULL,
       scopes = excluded.scopes,
       capabilities = excluded.capabilities,
       tokens = excluded.tokens,
       error = NULL,
       grant_started_at = excluded.grant_started_at,
       connected_at = NULL,
       updated_at = excluded.updated_at`,
    [
      id,
      patch.pluginID,
      patch.account,
      JSON.stringify(patch.scopes),
      JSON.stringify(patch.capabilities),
      JSON.stringify({ state }),
      now,
      now,
    ],
  );
  return getConnection(db, id)!;
}

/** Persist exchanged tokens + signed-in identity, mark connected. */
export function completeConnect(db: Database, id: string, tokens: Omit<TokenBlob, "state">, accountLabel: string): PluginConnectionRow {
  db.run(
    `UPDATE plugin_connections SET
       status = 'connected',
       account_label = ?,
       tokens = ?,
       error = NULL,
       connected_at = ?,
       updated_at = ?
     WHERE id = ?`,
    [accountLabel, JSON.stringify(tokens), nowISO(), nowISO(), id],
  );
  return getConnection(db, id)!;
}

export function updateTokens(db: Database, id: string, tokens: TokenBlob): void {
  db.run("UPDATE plugin_connections SET tokens = ?, updated_at = ? WHERE id = ?", [JSON.stringify(tokens), nowISO(), id]);
}

export function markError(db: Database, id: string, error: string): void {
  db.run("UPDATE plugin_connections SET status = 'error', error = ?, updated_at = ? WHERE id = ?", [error, nowISO(), id]);
}

/** Drop the row entirely; a disconnected plugin falls back to its catalog row. */
export function deleteConnection(db: Database, id: string): boolean {
  return db.run("DELETE FROM plugin_connections WHERE id = ?", [id]).changes > 0;
}
