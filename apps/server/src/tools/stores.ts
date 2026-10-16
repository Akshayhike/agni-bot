/**
 * Store tools. memory.search, links.search, tasks.list, and writes — all
 * bounded and indexed at write time (S2/S4). These run without approval.
 */
import type { Database } from "bun:sqlite";
import { searchMemories, createMemory, updateMemory, deleteMemory } from "../stores/memories";
import { searchLinks, saveLink, updateLink, deleteLink } from "../stores/links";
import { listTasks, createTask, setTaskStatus, snoozeTask, getTask } from "../stores/tasks";
import { fetchPage } from "./fetch-url";

export interface MemorySearchArgs {
  query: string;
  limit?: number;
}

export interface MemorySearchResult {
  memories: { id: string; text: string; summary: string | null; tags: string | null }[];
}

export function memorySearch(db: Database, args: MemorySearchArgs): MemorySearchResult {
  const rows = searchMemories(db, args.query, args.limit ?? 8);
  return { memories: rows.map((row) => ({ id: row.id, text: row.text, summary: row.summary, tags: row.tags })) };
}

export interface MemoryWriteArgs {
  text: string;
  tags?: string[];
}

export interface MemoryWriteResult {
  id: string;
  text: string;
}

export function memoryWrite(db: Database, args: MemoryWriteArgs): MemoryWriteResult {
  const row = createMemory(db, { text: args.text, tags: args.tags });
  return { id: row.id, text: row.text };
}

export interface MemoryUpdateArgs {
  id: string;
  text?: string;
  tags?: string[];
}

export function memoryUpdate(db: Database, args: MemoryUpdateArgs): MemoryWriteResult | null {
  const row = updateMemory(db, args.id, { text: args.text, tags: args.tags });
  return row ? { id: row.id, text: row.text } : null;
}

export interface MemoryDeleteArgs {
  id: string;
}

export function memoryDelete(db: Database, args: MemoryDeleteArgs): boolean {
  return deleteMemory(db, args.id);
}

export interface LinksSearchArgs {
  query: string;
  limit?: number;
}

export interface LinksSearchResult {
  links: { id: string; url: string; title: string | null; summary: string | null; note: string | null; tags: string | null }[];
}

export function linksSearch(db: Database, args: LinksSearchArgs): LinksSearchResult {
  const rows = searchLinks(db, args.query, args.limit ?? 8);
  return { links: rows.map((row) => ({ id: row.id, url: row.url, title: row.title, summary: row.summary, note: row.note, tags: row.tags })) };
}

export interface LinkSaveArgs {
  url: string;
  note?: string;
  tags?: string[];
}

export interface LinkSaveResult {
  id: string;
  url: string;
  title: string | null;
  summary: string | null;
}

export async function linkSave(db: Database, args: LinkSaveArgs): Promise<LinkSaveResult> {
  let page: { title: string | null; summary: string | null } = { title: null, summary: null };
  try { page = await fetchPage(args.url); } catch { /* URL and note are still saved */ }
  const row = saveLink(db, { url: args.url, ...page, note: args.note, tags: args.tags });
  return { id: row.id, url: row.url, title: row.title, summary: row.summary };
}

export interface TasksListArgs {
  status?: "open" | "done" | "snoozed" | "all";
  limit?: number;
}

export interface TasksListResult {
  tasks: { id: string; title: string; dueAt: string | null; priority: string; status: string; snoozedUntil: string | null }[];
}

export function tasksList(db: Database, args: TasksListArgs): TasksListResult {
  const rows = listTasks(db, { status: args.status ?? "open", limit: args.limit ?? 20, includeSnoozed: args.status === "open" });
  return { tasks: rows.map((row) => ({ id: row.id, title: row.title, dueAt: row.due_at, priority: row.priority, status: row.status, snoozedUntil: row.snoozed_until })) };
}

export interface TaskCreateArgs {
  title: string;
  dueAt?: string;
  priority?: "low" | "normal" | "high";
}

export interface TaskCreateResult {
  id: string;
  title: string;
  dueAt: string | null;
  priority: string;
}

export function taskCreate(db: Database, args: TaskCreateArgs): TaskCreateResult {
  const row = createTask(db, { title: args.title, dueAt: args.dueAt, priority: args.priority });
  return { id: row.id, title: row.title, dueAt: row.due_at, priority: row.priority };
}

export interface TaskUpdateArgs {
  id: string;
  action: "done" | "reopen" | "snooze";
  until?: string;
}

export function taskUpdate(db: Database, args: TaskUpdateArgs): TaskCreateResult | null {
  const old = getTask(db, args.id);
  if (!old) return null;
  let updated;
  if (args.action === "done") updated = setTaskStatus(db, old.id, "done");
  else if (args.action === "reopen") updated = setTaskStatus(db, old.id, "open");
  else if (args.action === "snooze") {
    if (!args.until) throw new Error("snooze requires an ISO timestamp in the future");
    updated = snoozeTask(db, old.id, args.until);
  } else throw new Error("unknown task action");
  return updated ? { id: updated.id, title: updated.title, dueAt: updated.due_at, priority: updated.priority } : null;
}