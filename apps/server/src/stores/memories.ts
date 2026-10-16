import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface MemoryRow {
  id: string;
  text: string;
  summary: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
  owner_device_id: string | null;
}

export function createMemory(db: Database, input: { text: string; tags?: string[]; ownerDeviceID?: string }): MemoryRow {
  const text = input.text.trim();
  if (!text || text.length > 20_000) throw new Error("memory text must be 1–20000 characters");
  const id = newID("mem");
  const timestamp = nowISO();
  const tags = normalizeTags(input.tags);
  const write = db.transaction(() => {
    db.run("INSERT INTO memories(id,text,summary,tags,created_at,updated_at,owner_device_id) VALUES(?,?,NULL,?,?,?,?)", [id, text, tags, timestamp, timestamp, input.ownerDeviceID ?? null]);
    db.run("INSERT INTO memories_fts(id,text,summary,tags) VALUES(?,?,?,?)", [id, text, "", tags ?? ""]);
  });
  write();
  return getMemory(db, id)!;
}

export function updateMemory(db: Database, id: string, patch: { text?: string; summary?: string | null; tags?: string[] }): MemoryRow | null {
  const old = getMemory(db, id);
  if (!old) return null;
  const text = patch.text?.trim() ?? old.text;
  if (!text || text.length > 20_000) throw new Error("memory text must be 1–20000 characters");
  const summary = patch.summary === undefined ? old.summary : patch.summary;
  const tags = patch.tags === undefined ? old.tags : normalizeTags(patch.tags);
  db.transaction(() => {
    db.run("UPDATE memories SET text=?,summary=?,tags=?,updated_at=? WHERE id=?", [text, summary, tags, nowISO(), id]);
    db.run("DELETE FROM memories_fts WHERE id=?", [id]);
    db.run("INSERT INTO memories_fts(id,text,summary,tags) VALUES(?,?,?,?)", [id, text, summary ?? "", tags ?? ""]);
  })();
  return getMemory(db, id);
}

export function deleteMemory(db: Database, id: string): boolean {
  return db.transaction(() => {
    db.run("DELETE FROM memories_fts WHERE id=?", [id]);
    return db.run("DELETE FROM memories WHERE id=?", [id]).changes > 0;
  })();
}

export function getMemory(db: Database, id: string): MemoryRow | null {
  return db.query<MemoryRow, [string]>("SELECT * FROM memories WHERE id=?").get(id) ?? null;
}

export function searchMemories(db: Database, query: string, limit = 10): MemoryRow[] {
  const safeLimit = clampLimit(limit);
  const terms = ftsQuery(query);
  if (!terms) return db.query<MemoryRow, [number]>("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ?").all(safeLimit);
  try {
    return db.query<MemoryRow, [string, number]>("SELECT m.* FROM memories_fts f JOIN memories m ON m.id=f.id WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?").all(terms, safeLimit);
  } catch {
    return [];
  }
}

export function normalizeTags(tags: string[] | undefined): string | null {
  if (!tags?.length) return null;
  const clean = [...new Set(tags.map((tag) => tag.trim().replace(/\s+/g, " ")).filter(Boolean))];
  if (clean.some((tag) => tag.length > 64) || clean.length > 20) throw new Error("tags must be at most 20 items of 64 characters");
  return clean.join(", ") || null;
}

export function ftsQuery(query: string): string {
  return query.trim().split(/\s+/).filter(Boolean).slice(0, 12).map((word) => `"${word.replaceAll('"', '""')}"`).join(" AND ");
}

export function clampLimit(limit: number): number {
  return Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 10;
}
