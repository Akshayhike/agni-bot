/**
 * Session-block compaction — the write-time work behind the conversation
 * model. A block closes (manual /new, context pressure, or background work)
 * and its story folds into one bounded carried summary that the next block
 * opens with. The user never sees a context wall; the summary is the seam.
 *
 * S4: summaries are written when a block closes and land in SQLite, never
 * computed at turn time. Failures degrade by carrying the previous summary
 * forward — a missing summary must never block a turn.
 */
import type { Database } from "bun:sqlite";
import { Router, RouterError } from "../models/router";
import { recentMessages, type ThreadRow } from "../stores/threads";
import {
  activeSession,
  ensureConversation,
  getConversation,
  openSession,
  sessionCharLoad,
  updateSummary,
  type ConversationRow,
  type SessionCloseReason,
} from "../stores/conversations";import { log } from "../log";

/**
 * A block crossing this many chars of accumulated message text rolls over
 * before the next turn (~8k tokens of prose). The S1 prompt window keeps the
 * model honest regardless; this keeps the block a request-sized unit.
 */
export const SESSION_ROLLOVER_CHARS = 32_000;

/** Hard cap on the carried summary the next block opens with. */
export const CARRY_SUMMARY_CHARS = 900;

const SUMMARY_SYSTEM_PROMPT = [
  "You compress a chat session for continuity. Write 2-5 plain sentences covering:",
  "what was asked or decided, anything still owed or pending, and any preference the user expressed.",
  "No preamble, no headings — the text is pasted verbatim into the next session's context.",
].join(" ");

export interface RolloverResult {
  /** The block the next turn writes into. */
  threadID: string;
  /** The carried summary this block opened with. */
  carry: string | null;
  /** Whether a block boundary actually happened (rollover or fresh block). */
  rolledOver: boolean;
  conversationID: string;
  /** What caused the boundary: one of the session reasons, or "none". */
  reason: SessionCloseReason | "none";
}

export interface RolloverDeps {
  db: Database;
  router: Router;
  firstTokenTimeoutMs: number;
}

/**
 * Make sure the conversation has a writable block the next turn can use:
 * close-and-rotate when the active block is at pressure, open a fresh one
 * when there is none. Returns the block id and the carried summary.
 */
export async function rolloverIfNeeded(deps: RolloverDeps, conversation: ConversationRow): Promise<RolloverResult> {
  const active = activeSession(deps.db, conversation);
  if (active && sessionCharLoad(deps.db, active.id) < SESSION_ROLLOVER_CHARS) {
    return {
      threadID: active.id,
      // Re-read: the caller may hold a snapshot from before an earlier write.
      carry: getConversation(deps.db, conversation.id)?.summary ?? null,
      rolledOver: false,
      conversationID: conversation.id,
      reason: "none",
    };
  }
  const reason: SessionCloseReason = active ? "context" : "manual";
  return rotate(deps, conversation, reason);
}

/**
 * Rotate now: summarize the active block into the carried summary, close it,
 * open a fresh one. `manual` (/new), `context` (pressure), `background`
 * (routine landing) only changes the closed_by marker, not the flow.
 */
export async function rotate(deps: RolloverDeps, agentOrConversation: string | ConversationRow, reason: SessionCloseReason): Promise<RolloverResult> {
  const { db, router } = deps;
  const conversation =
    typeof agentOrConversation === "string"
      ? ensureConversation(db, agentOrConversation)
      : (getConversation(db, agentOrConversation.id) ?? agentOrConversation);
  const active = activeSession(db, conversation);
  const carry = active ? await carryForward(deps, conversation, active) : (conversation.summary ?? null);
  const block = openSession(db, conversation, reason, carry);
  log.info(
    `session block rotated conversation=${conversation.id} reason=${reason} closed=${active ? active.id : "-"} opened=${block.id}`,
  );
  return { threadID: block.id, carry, rolledOver: true, conversationID: conversation.id, reason };
}

/**
 * Fold the closed block into the running carry. One bounded call; on any
 * failure the previous carry rides forward unchanged.
 */
async function carryForward(deps: RolloverDeps, conversation: ConversationRow, block: ThreadRow): Promise<string | null> {
  const previous = conversation.summary ?? "";
  const transcript = recentMessages(deps.db, block.id, 40)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n")
    .slice(0, 12_000);
  try {
    const result = await deps.router.route({
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: [previous ? `Running summary so far:\n${previous}` : null, `Session to fold in:\n${transcript}`]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      signal: AbortSignal.timeout(20_000),
      firstTokenTimeoutMs: deps.firstTokenTimeoutMs,
      onDelta: () => {},
      toolChoice: "none",
      maxTokens: 400,
    });
    const text = clampCarry(result.text.trim() || previous || null);
    if (!text) throw new RouterError("provider_failed", "empty summary");
    updateSummary(deps.db, conversation.id, text);
    return text;
  } catch (error) {
    log.warn(`carry summary failed; previous summary rides forward: ${error instanceof Error ? error.message : String(error)}`);
    return previous || null;
  }
}

/** Carry is a seam, not storage: keep it short, no matter what the model said. */
function clampCarry(text: string | null): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > CARRY_SUMMARY_CHARS ? `${cleaned.slice(0, CARRY_SUMMARY_CHARS)}…` : cleaned;
}

/** Rotate by conversation id when the caller already holds the id. */
export async function rotateById(deps: RolloverDeps, conversationID: string, reason: SessionCloseReason): Promise<RolloverResult> {
  const conversation = getConversation(deps.db, conversationID);
  if (!conversation) throw new Error(`no conversation ${conversationID}`);
  return rotate(deps, conversation, reason);
}
