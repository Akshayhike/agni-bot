import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface ThreadRow {
  id: string;
  agent_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  role: string;
  text: string;
  created_at: string;
}

export function createThread(db: Database, agentID: string, title?: string): ThreadRow {
  const row: ThreadRow = {
    id: newID("thr"),
    agent_id: agentID,
    title: title ?? null,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  db.run("INSERT INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    row.id,
    row.agent_id,
    row.title,
    row.created_at,
    row.updated_at,
  ]);
  return row;
}

export function getThread(db: Database, id: string): ThreadRow | null {
  return (
    db
      .query<ThreadRow, [string]>("SELECT id, agent_id, title, created_at, updated_at FROM threads WHERE id = ?")
      .get(id) ?? null
  );
}

export function touchThread(db: Database, id: string): void {
  db.run("UPDATE threads SET updated_at = ? WHERE id = ?", [nowISO(), id]);
}

/** Set the thread title from the first user message if it has none yet. */
export function titleThreadFromFirstMessage(db: Database, threadID: string, text: string): void {
  const title = text.trim().replace(/\s+/g, " ").slice(0, 60);
  db.run("UPDATE threads SET title = ?, updated_at = ? WHERE id = ? AND (title IS NULL OR title = '')", [
    title,
    nowISO(),
    threadID,
  ]);
}

export function createTurn(db: Database, params: { id: string; threadID: string; agentID: string }): void {
  db.run("INSERT INTO turns (id, thread_id, agent_id, state, started_at) VALUES (?, ?, ?, 'running', ?)", [
    params.id,
    params.threadID,
    params.agentID,
    nowISO(),
  ]);
}

export function finishTurn(
  db: Database,
  params: {
    id: string;
    stopReason: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  },
): void {
  db.run(
    `UPDATE turns
     SET state = 'done', stop_reason = ?, provider = ?, model = ?, input_tokens = ?, output_tokens = ?, latency_ms = ?, ended_at = ?
     WHERE id = ?`,
    [
      params.stopReason,
      params.provider ?? null,
      params.model ?? null,
      params.inputTokens ?? null,
      params.outputTokens ?? null,
      params.latencyMs ?? null,
      nowISO(),
      params.id,
    ],
  );
}

export function appendMessage(
  db: Database,
  params: { threadID: string; turnID?: string; role: string; text: string },
): MessageRow {
  const row: MessageRow = {
    id: newID("msg"),
    thread_id: params.threadID,
    turn_id: params.turnID ?? null,
    role: params.role,
    text: params.text,
    created_at: nowISO(),
  };
  db.run("INSERT INTO messages (id, thread_id, turn_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    row.id,
    row.thread_id,
    row.turn_id,
    row.role,
    row.text,
    row.created_at,
  ]);
  return row;
}

/** Last `limit` messages in chronological order — the bounded prompt (S1). */
export function recentMessages(db: Database, threadID: string, limit: number): MessageRow[] {
  const rows = db
    .query<MessageRow, [string, number]>(
      `SELECT id, thread_id, turn_id, role, text, created_at
       FROM messages WHERE thread_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(threadID, limit);
  return rows.reverse();
}
