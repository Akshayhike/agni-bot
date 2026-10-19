/**
 * File write tool. Writes content to any path, creating parent directories as
 * needed. There is no enforced sandbox here — the guard is policy, not
 * mechanism: `ApprovalBroker.requiresApproval` routes writes *outside* the
 * scratch tree through the approval card, and lets scratch writes run free
 * (AGENTS.md). `isOutsideScratch` is the boundary check both sides share.
 */
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const MAX_BYTES = 1024 * 1024;

/**
 * The tree the owner has declared safe for ungated writes. Defaults to
 * `<cwd>/scratch`; `AGNI_SCRATCH_DIR` overrides it (bb-1 keeps scratch on a
 * separate volume). An absolute `AGNI_SCRATCH_DIR` is used as given.
 */
export function scratchDir(): string {
  const configured = process.env.AGNI_SCRATCH_DIR;
  return resolve(configured && configured.length > 0 ? configured : join(process.cwd(), "scratch"));
}

/** True when `path` is outside the scratch tree, i.e. a write that gates. */
export function isOutsideScratch(path: string): boolean {
  if (path.trim().length === 0) return true;
  const target = resolve(isAbsolute(path) ? path : join(process.cwd(), path));
  const scratch = scratchDir();
  return target !== scratch && !target.startsWith(scratch.endsWith(sep) ? scratch : scratch + sep);
}

export interface WriteFileArgs {
  path: string;
  content: string;
  append?: boolean;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export function writeFile(args: WriteFileArgs): WriteFileResult {
  if (args.content.length > MAX_BYTES) throw new Error("content exceeds 1 MB");
  let created = false;
  try { statSync(args.path); } catch { created = true; }
  mkdirSync(join(args.path, ".."), { recursive: true });
  if (args.append) {
    const existing = created ? "" : require("node:fs").readFileSync(args.path, "utf8");
    writeFileSync(args.path, existing + args.content, { flag: "w" });
  } else {
    writeFileSync(args.path, args.content, { flag: "w" });
  }
  return { path: args.path, bytesWritten: args.content.length, created };
}