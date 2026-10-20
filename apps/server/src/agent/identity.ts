/**
 * Agent identity: the single place a rename happens.
 *
 * The `agent.rename` frame handler (the name field in the app) and the
 * `rename_agent` chat tool both go through here, so a rename from chat and a
 * rename from the UI cannot drift apart — one writes `agents.display_name`,
 * both emit `agent.updated`, and the prompt picks the new name up on the next
 * turn because `resolvePersona` reads that column.
 *
 * A rename also settles the "what should I call you?" prompt: the stored
 * message is marked completed, so the field is gone the next time the thread
 * is loaded instead of asking for a name it already has.
 */
import type { Database } from "bun:sqlite";
import { canonicalAgentID } from "./personas";
import { nowISO } from "../util/ids";

export const MAX_AGENT_NAME_CHARS = 64;

export type RenameOutcome =
  | { ok: true; agentID: string; previousName: string | null; name: string }
  | { ok: false; reason: string };

/** Collapse whitespace and enforce the frame contract: 1–64 chars, one line. */
export function normalizeAgentName(proposed: string): string | null {
  const name = proposed.replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_AGENT_NAME_CHARS) return null;
  // Whitespace is collapsed above, so anything left in the control range is a
  // real reject (NUL, ESC, …) rather than an over-strict newline check.
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function renameAgent(db: Database, agentID: string, proposedName: string): RenameOutcome {
  const name = normalizeAgentName(proposedName);
  if (!name) return { ok: false, reason: `name must be 1–${MAX_AGENT_NAME_CHARS} characters on one line` };
  const target = canonicalAgentID(agentID);
  const row = db
    .query<{ id: string; display_name: string | null }, [string]>("SELECT id, display_name FROM agents WHERE id = ?")
    .get(target);
  if (!row) return { ok: false, reason: `no agent with id ${target}` };
  const now = nowISO();
  db.run("UPDATE agents SET display_name = ?, onboarded = 1, updated_at = ? WHERE id = ?", [name, now, target]);
  // `agni` is the legacy alias row for the same persona; keep it in step so raw
  // SQL and old threads never show two names for one agent.
  if (target === "ea") db.run("UPDATE agents SET display_name = ?, updated_at = ? WHERE id = 'agni'", [name, now]);
  settleOnboardingPrompt(db, target);
  return { ok: true, agentID: target, previousName: row.display_name?.trim() || null, name };
}

/**
 * The inline "what should I call you?" prompt is stored once, with the hint
 * that renders the name field. Once the agent has a name the field has no
 * business reappearing, so the stored message is marked completed — the
 * thread then shows "Renamed to …" instead of asking again.
 */
function settleOnboardingPrompt(db: Database, agentID: string): void {
  db.run(
    "UPDATE channel_messages SET ui_hint = 'onboarding_completed' WHERE channel_id = 'main' AND ui_hint = 'onboarding_name_prompt' AND from_id = ?",
    [agentID],
  );
}
