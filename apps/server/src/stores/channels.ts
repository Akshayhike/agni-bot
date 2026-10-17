import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface ChannelRow {
  id: string;
  type: string;
  visibility: string;
  name: string;
  agent_id: string;
  parent_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelMemberRow {
  channel_id: string;
  participant_type: string;
  participant_id: string;
  role: string;
}

export interface ChannelMessageRow {
  id: string;
  channel_id: string;
  from_type: string;
  from_id: string;
  to_agent_id: string | null;
  text: string;
  ui_hint: string | null;
  internal: number;
  compacted: number;
  turn_id: string | null;
  created_at: string;
}

export interface ChannelSummaryRow {
  id: string;
  channel_id: string;
  summary: string;
  last_compacted_message_id: string | null;
  token_estimate: number;
  updated_at: string;
}

export function createChannel(
  db: Database,
  input: { type: string; visibility: string; name: string; agentID: string; parentTurnID?: string },
): ChannelRow {
  const created = nowISO();
  const row: ChannelRow = {
    id: newID("chn"), type: input.type, visibility: input.visibility, name: input.name,
    agent_id: input.agentID, parent_turn_id: input.parentTurnID ?? null, created_at: created, updated_at: created,
  };
  db.run(
    `INSERT INTO channels (id, type, visibility, name, agent_id, parent_turn_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.type, row.visibility, row.name, row.agent_id, row.parent_turn_id, row.created_at, row.updated_at],
  );
  return row;
}

export function listChannels(db: Database, agentID?: string): ChannelRow[] {
  const sql = `SELECT id, type, visibility, name, agent_id, parent_turn_id, created_at, updated_at FROM channels`;
  return agentID
    ? db.query<ChannelRow, [string]>(`${sql} WHERE agent_id = ? ORDER BY created_at`).all(agentID)
    : db.query<ChannelRow, []>(`${sql} ORDER BY created_at`).all();
}

export function getChannel(db: Database, id: string): ChannelRow | null {
  return db.query<ChannelRow, [string]>(
    `SELECT id, type, visibility, name, agent_id, parent_turn_id, created_at, updated_at FROM channels WHERE id = ?`,
  ).get(id) ?? null;
}

export function renameChannel(db: Database, id: string, name: string): void {
  db.run("UPDATE channels SET name = ?, updated_at = ? WHERE id = ?", [name, nowISO(), id]);
}

export function addChannelMember(db: Database, channelID: string, participantID: string, participantType = "agent", role = "member"): void {
  db.run(
    "INSERT OR IGNORE INTO channel_members (channel_id, participant_type, participant_id, role) VALUES (?, ?, ?, ?)",
    [channelID, participantType, participantID, role],
  );
}

export function listChannelMembers(db: Database, channelID: string): ChannelMemberRow[] {
  return db.query<ChannelMemberRow, [string]>(
    "SELECT channel_id, participant_type, participant_id, role FROM channel_members WHERE channel_id = ? ORDER BY participant_type, participant_id",
  ).all(channelID);
}

export function appendChannelMessage(
  db: Database,
  input: {
    channelID: string; fromType: string; fromID: string; toAgentID?: string | null; text: string;
    internal?: boolean; turnID?: string | null; uiHint?: string;
  },
): ChannelMessageRow {
  const row: ChannelMessageRow = {
    id: newID("chm"), channel_id: input.channelID, from_type: input.fromType, from_id: input.fromID,
    to_agent_id: input.toAgentID ?? null, text: input.text, ui_hint: input.uiHint ?? null,
    internal: input.internal ? 1 : 0, compacted: 0, turn_id: input.turnID ?? null, created_at: nowISO(),
  };
  db.run(
    `INSERT INTO channel_messages (id, channel_id, role, text, status, turn_id, created_at, from_type, from_id, to_agent_id, ui_hint, internal, compacted)
     VALUES (?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.channel_id, input.fromType === "agent" ? "assistant" : input.fromType, row.text,
      row.turn_id, row.created_at, row.from_type, row.from_id, row.to_agent_id, row.ui_hint,
      row.internal, row.compacted],
  );
  return row;
}

export function listChannelMessages(db: Database, channelID: string, limit = 200): ChannelMessageRow[] {
  return db.query<ChannelMessageRow, [string, number]>(
    `SELECT id, channel_id, from_type, from_id, to_agent_id, text, ui_hint, internal, compacted, turn_id, created_at
     FROM channel_messages WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(channelID, limit).reverse();
}

export function uncompactedMessages(db: Database, channelID: string, limit = 100): ChannelMessageRow[] {
  return db.query<ChannelMessageRow, [string, number]>(
    `SELECT id, channel_id, from_type, from_id, to_agent_id, text, ui_hint, internal, compacted, turn_id, created_at
     FROM channel_messages WHERE channel_id = ? AND compacted = 0 ORDER BY created_at, rowid LIMIT ?`,
  ).all(channelID, limit);
}

export function markMessagesCompacted(db: Database, ids: string[]): void {
  if (!ids.length) return;
  db.run(`UPDATE channel_messages SET compacted = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
}

export function updateChannelMessageStatus(_db: Database, _id: string, _status: string): void {
  // Message delivery status is intentionally not part of this schema.
}

export function getChannelSummary(db: Database, channelID: string): ChannelSummaryRow | null {
  return db.query<ChannelSummaryRow, [string]>(
    "SELECT id, channel_id, summary, last_compacted_message_id, token_estimate, updated_at FROM channel_summaries WHERE channel_id = ?",
  ).get(channelID) ?? null;
}

export function addChannelSummary(
  db: Database,
  channelID: string,
  summary: string,
  lastCompactedMessageID: string | null,
  tokenEstimate: number,
): ChannelSummaryRow {
  const row = { id: newID("chs"), channel_id: channelID, summary, last_compacted_message_id: lastCompactedMessageID,
    token_estimate: Math.max(0, Math.floor(tokenEstimate)), updated_at: nowISO() };
  db.run(
    `INSERT INTO channel_summaries (id, channel_id, summary, last_compacted_message_id, token_estimate, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET summary=excluded.summary,
       last_compacted_message_id=excluded.last_compacted_message_id, token_estimate=excluded.token_estimate, updated_at=excluded.updated_at`,
    [row.id, row.channel_id, row.summary, row.last_compacted_message_id, row.token_estimate, row.updated_at],
  );
  return getChannelSummary(db, channelID)!;
}

export function listChannelSummaries(db: Database, channelID: string, limit = 1): ChannelSummaryRow[] {
  const row = getChannelSummary(db, channelID);
  return row && limit > 0 ? [row] : [];
}
