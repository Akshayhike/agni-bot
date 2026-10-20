/**
 * Plugin-stored credentials, read at the moment a tool needs them.
 *
 * The Plugins pane writes secrets into the daemon's mode-600 plugins.json.
 * The tools read them from there — not from .env — so that what the owner
 * connects in the UI is exactly what the agent can use. A mailbox connected
 * in Settings → Plugins has to work, or the connect is a lie.
 */
import { loadPluginsFile } from "./config";

export interface MailAccount {
  /** The account email (IMAP user). */
  user: string;
  /** The app password. */
  pass: string;
}

/** The catalog plugin that owns each mailbox account. */
const MAIL_PLUGIN: Record<"agent" | "owner", string> = { agent: "gmail", owner: "gmail-owner" };

/** Resolves the mailbox credentials for an account, or null when not connected. */
export type MailAccountResolver = (account: "agent" | "owner") => MailAccount | null;

/** The mailbox credentials the owner connected for `account`, if any. */
export function mailCredentialsFromPlugins(pluginsPath: string, account: "agent" | "owner"): MailAccount | null {
  if (!pluginsPath) return null;
  const entry = loadPluginsFile(pluginsPath).plugins[MAIL_PLUGIN[account]];
  if (!entry?.enabled) return null;
  if (entry.auth.kind !== "app-password") return null;
  const user = entry.auth.user?.trim() ?? "";
  const pass = entry.auth.pass ?? "";
  if (!user || !pass) return null;
  return { user, pass };
}

/**
 * A resolver that reads the connected plugin's credentials from disk on every
 * call: a connect made in the UI has to take effect on the next tool call,
 * not on the next daemon restart.
 */
export function pluginMailResolver(pluginsPath: string): MailAccountResolver {
  return (account) => mailCredentialsFromPlugins(pluginsPath, account);
}
