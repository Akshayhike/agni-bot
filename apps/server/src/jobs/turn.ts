/**
 * The `turn` job kind: run one prompt in a thread as background work. This is
 * how the daemon does things unprompted — reminders, the precomputed 07:55
 * brief, link resurfacing — and how it chats back: the turn streams to any
 * connected client through the normal frames, and completion raises a
 * `notify` frame.
 *
 * Payload: { threadID?, text, agentID?, notify?, maxReplyChars?, everyMs? }
 *   - threadID: reuse a thread; otherwise the job creates one.
 *   - everyMs:  recurring — schedule the next run after this one succeeds.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { runInstantTurn, type TurnSettings } from "../agent/loop";
import { defaultPersona, getPersona } from "../agent/personas";
import type { Router } from "../models/router";
import { getThread } from "../stores/threads";
import { backgroundSession, ensureConversation, getConversation, type ConversationRow } from "../stores/conversations";
import { parseJobPayload, type JobRow } from "../stores/jobs";
import type { JobRunner } from "./runner";

export interface TurnJobPayload {
  threadID?: string;
  text: string;
  agentID?: string;
  /** Raise a notify frame when the turn ends. Default true. */
  notify?: boolean;
  everyMs?: number;
}

export interface TurnJobDeps {
  db: Database;
  router: Router;
  settings: TurnSettings;
  emit: (frame: ServerFrameBody) => void;
}

export function registerTurnJob(runner: JobRunner, deps: TurnJobDeps): void {
  runner.register("turn", async (job: JobRow) => {
    const payload = parseJobPayload<TurnJobPayload>(job);
    const text = payload.text?.trim();
    if (!text) throw new Error("turn job payload has no text");

    const persona = (payload.agentID ? getPersona(payload.agentID) : undefined) ?? defaultPersona();

    let threadID = payload.threadID?.trim();
    let conversation: ConversationRow | undefined;
    if (threadID) {
      const existing = getThread(deps.db, threadID);
      if (!existing) throw new Error(`thread ${threadID} no longer exists`);
      // A recurring job keeps the block it created: one routine is one
      // conversation with the agent (blueprint §process lifecycle).
      conversation = existing.conversation_id ? (getConversation(deps.db, existing.conversation_id) ?? undefined) : undefined;
    } else {
      // Background results need a home, and the home is the conversation:
      // a new session block inside it, so the user sees the result where
      // they already chat with the agent. It never takes over the active
      // chat block, and recurring runs keep landing in the same one.
      const cnv = ensureConversation(deps.db, persona.id);
      threadID = backgroundSession(deps.db, cnv, payload.text.trim().replace(/\s+/g, " ").slice(0, 60)).id;
      conversation = getConversation(deps.db, cnv.id) ?? undefined;
      deps.db.run("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify({ ...payload, threadID }),
        new Date().toISOString(),
        job.id,
      ]);
    }

    const result = await runInstantTurn(deps.db, deps.router, deps.settings, {
      threadID,
      text,
      persona,
      conversationID: conversation?.id,
      carrySummary: conversation?.summary ?? null,
      emit: deps.emit,
      signal: new AbortController().signal,
    });

    if (result.stopReason !== "end") {
      // runInstantTurn already reported the failure as frames; a non-end stop
      // is a failed job so the runner retries it honestly.
      throw new Error(`turn ended with ${result.stopReason}${result.text ? " (partial output kept)" : ""}`);
    }

    const reply = firstLine(result.text);
    if (payload.notify !== false) {
      deps.emit({ type: "notify", title: `${persona.name} · ${truncate(text, 60)}`, body: reply, sound: false });
    }

    const outcome: { result: string; nextRunAt?: string } = { result: `thread ${threadID}: ${reply}` };
    if (payload.everyMs && payload.everyMs > 0) {
      outcome.nextRunAt = new Date(Date.now() + payload.everyMs).toISOString();
    }
    return outcome;
  });
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return truncate(line, 180) || "(no output)";
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
