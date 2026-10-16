import type { Database } from "bun:sqlite";
import { newID, nowISO, utcDay } from "../util/ids";

export interface UsageRecord {
  turnID?: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}

/** Spend ledger — one row per completed turn. Visible per thread (P1+) and per day. */
export function recordUsage(db: Database, record: UsageRecord): void {
  db.run(
    "INSERT INTO usage_ledger (id, turn_id, provider, model, input_tokens, output_tokens, latency_ms, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      newID("use"),
      record.turnID ?? null,
      record.provider,
      record.model,
      record.inputTokens ?? 0,
      record.outputTokens ?? 0,
      record.latencyMs ?? null,
      utcDay(),
      nowISO(),
    ],
  );
}

export interface DayTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export function dayTotals(db: Database, day = utcDay()): DayTotals {
  const row = db
    .query<{ turns: number; input_tokens: number | null; output_tokens: number | null }, [string]>(
      `SELECT COUNT(*) AS turns, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM usage_ledger WHERE day = ?`,
    )
    .get(day);
  return {
    turns: row?.turns ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
  };
}
