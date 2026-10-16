import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import { clampLimit, ftsQuery } from "./memories";

export interface LinkRow {
  id: string;
  url: string;
  title: string | null;
  summary: string | null;
  note: string | null;
  tags: string | null;
  created_at: string;
  owner_device_id: string | null;
}

export function canonicalURL(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http and https URLs can be saved");
  if (url.username || url.password) throw new Error("URLs with credentials cannot be saved");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function saveLink(db: Database, input: { url: string; title?: string | null; summary?: string | null; note?: string | null; tags?: string[]; ownerDeviceID?: string }): LinkRow {
  const url = canonicalURL(input.url);
  const existing = db.query<LinkRow, [string]>("SELECT * FROM links WHERE url=? ORDER BY created_at LIMIT 1").get(url);
  if (existing) {
    const merged = { ...existing, title: input.title?.trim() || existing.title, summary: input.summary?.trim() || existing.summary,
      note: input.note?.trim() ? [existing.note, input.note.trim()].filter(Boolean).join("\n") : existing.note,
      tags: mergeTags(existing.tags, input.tags) };
    db.transaction(() => {
      db.run("UPDATE links SET title=?,summary=?,note=?,tags=? WHERE id=?", [merged.title, merged.summary, merged.note, merged.tags, existing.id]);
      indexLink(db, merged);
    })();
    return getLink(db, existing.id)!;
  }
  const row: LinkRow = { id: newID("lnk"), url, title: input.title?.trim() || null, summary: input.summary?.trim() || null,
    note: input.note?.trim() || null, tags: input.tags?.map((v) => v.trim()).filter(Boolean).join(", ") || null,
    created_at: nowISO(), owner_device_id: input.ownerDeviceID ?? null };
  db.transaction(() => {
    db.run("INSERT INTO links(id,url,title,summary,note,tags,created_at,owner_device_id) VALUES(?,?,?,?,?,?,?,?)", [row.id,row.url,row.title,row.summary,row.note,row.tags,row.created_at,row.owner_device_id]);
    indexLink(db, row);
  })();
  return row;
}

export function updateLink(db: Database, id: string, patch: { note?: string | null; title?: string | null; summary?: string | null; tags?: string[] }): LinkRow | null {
  const old = getLink(db, id);
  if (!old) return null;
  const row = { ...old, title: patch.title === undefined ? old.title : patch.title?.trim() || null,
    summary: patch.summary === undefined ? old.summary : patch.summary?.trim() || null,
    note: patch.note === undefined ? old.note : patch.note?.trim() || null,
    tags: patch.tags === undefined ? old.tags : patch.tags.map((v) => v.trim()).filter(Boolean).join(", ") || null };
  db.transaction(() => {
    db.run("UPDATE links SET title=?,summary=?,note=?,tags=? WHERE id=?", [row.title,row.summary,row.note,row.tags,id]);
    indexLink(db,row);
  })();
  return getLink(db,id);
}

export function deleteLink(db: Database, id: string): boolean {
  return db.transaction(() => { db.run("DELETE FROM links_fts WHERE id=?",[id]); return db.run("DELETE FROM links WHERE id=?",[id]).changes > 0; })();
}

export function getLink(db: Database, id: string): LinkRow | null {
  return db.query<LinkRow,[string]>("SELECT * FROM links WHERE id=?").get(id) ?? null;
}

export function searchLinks(db: Database, query: string, limit=10): LinkRow[] {
  const q=ftsQuery(query), n=clampLimit(limit);
  if (!q) return db.query<LinkRow,[number]>("SELECT * FROM links ORDER BY created_at DESC LIMIT ?").all(n);
  try { return db.query<LinkRow,[string,number]>("SELECT l.* FROM links_fts f JOIN links l ON l.id=f.id WHERE links_fts MATCH ? ORDER BY rank LIMIT ?").all(q,n); }
  catch { return []; }
}

function indexLink(db: Database,row: LinkRow): void {
  db.run("DELETE FROM links_fts WHERE id=?",[row.id]);
  db.run("INSERT INTO links_fts(id,title,summary,note,tags) VALUES(?,?,?,?,?)",[row.id,row.title??"",row.summary??"",row.note??"",row.tags??""]);
}

function mergeTags(current: string|null, incoming?: string[]): string|null {
  const all=[...(current?.split(",")??[]),...(incoming??[])].map(x=>x.trim()).filter(Boolean);
  return [...new Set(all)].join(", ") || null;
}
