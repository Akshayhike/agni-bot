/**
 * File read tool. Reads a file from the sandbox directory and returns its
 * contents (truncated to a sane size). Paths outside the sandbox are rejected.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX_DIR = process.env.AGNI_SANDBOX_DIR ?? join(tmpdir(), "agni-sandbox");
const MAX_BYTES = 256 * 1024;

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadFileResult {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  offset: number;
  lines: number;
}

export function resolveSandboxPath(relativePath: string): string {
  const base = realpathSync(SANDBOX_DIR);
  const target = resolve(base, relativePath);
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel === "..") throw new Error("path escapes the sandbox directory");
  return target;
}

export function readFile(args: ReadFileArgs): ReadFileResult {
  const target = resolveSandboxPath(args.path);
  const stat = statSync(target);
  if (!stat.isFile()) throw new Error(`${args.path} is not a file`);
  const content = readFileSync(target, "utf8");
  const lines = content.split("\n");
  const start = Math.max(0, args.offset ?? 0);
  const count = args.limit ?? lines.length;
  const slice = lines.slice(start, start + count).join("\n");
  const truncated = content.length > MAX_BYTES || slice.length >= MAX_BYTES;
  return {
    path: args.path,
    size: stat.size,
    content: slice.length > MAX_BYTES ? `${slice.slice(0, MAX_BYTES)}\n…[truncated]` : slice,
    truncated,
    offset: start,
    lines: lines.length,
  };
}