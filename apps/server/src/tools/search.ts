/**
 * Search tools. Grep and glob over the sandbox directory. Both are bounded in
 * output size and reject paths that escape the sandbox.
 */
import { readdirSync, statSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, relative, basename, dirname } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX_DIR = process.env.AGNI_SANDBOX_DIR ?? join(tmpdir(), "agni-sandbox");
const MAX_RESULTS = 200;
const MAX_LINE_LENGTH = 2000;

export interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

export function resolveSandboxPath(relativePath: string): string {
  const base = realpathSyncSafe(SANDBOX_DIR);
  const target = resolve(base, relativePath);
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel === "..") throw new Error("path escapes the sandbox directory");
  return target;
}

function realpathSyncSafe(dir: string): string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

export function grep(args: GrepArgs): GrepResult {
  const root = args.path ? resolveSandboxPath(args.path) : SANDBOX_DIR;
  const regex = buildRegex(args.pattern, args.ignoreCase);
  const includeGlob = args.include ? normalizeGlob(args.include) : null;
  const matches: GrepMatch[] = [];
  let truncated = false;
  const limit = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);

  walk(root, (path) => {
    if (matches.length >= limit) { truncated = true; return false; }
    if (includeGlob && !matchGlob(basename(path), includeGlob)) return true;
    try {
      const content = require("node:fs").readFileSync(path, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= limit) { truncated = true; return false; }
        const line = lines[i]!;
        if (regex.test(line)) {
          matches.push({
            path: relative(SANDBOX_DIR, path),
            line: i + 1,
            content: line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line,
          });
        }
      }
    } catch {
      // binary or unreadable — skip
    }
    return true;
  });

  return { matches, truncated };
}

export interface GlobArgs {
  pattern: string;
  path?: string;
  maxResults?: number;
}

export interface GlobResult {
  matches: string[];
  truncated: boolean;
}

export function glob(args: GlobArgs): GlobResult {
  const root = args.path ? resolveSandboxPath(args.path) : SANDBOX_DIR;
  const globRe = normalizeGlob(args.pattern);
  const matches: string[] = [];
  let truncated = false;
  const limit = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);

  walk(root, (path) => {
    if (matches.length >= limit) { truncated = true; return false; }
    if (matchGlob(basename(path), globRe)) matches.push(relative(SANDBOX_DIR, path));
    return true;
  });

  return { matches, truncated };
}

function buildRegex(pattern: string, ignoreCase?: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? "iu" : "u");
  } catch {
    // Fall back to literal matching if the pattern is not valid regex.
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, ignoreCase ? "iu" : "u");
  }
}

function normalizeGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchGlob(name: string, regex: RegExp): boolean {
  return regex.test(name);
}

function walk(root: string, visitor: (path: string) => boolean): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (isDir) {
        if (entry === "node_modules" || entry === ".git") continue;
        stack.push(full);
      } else {
        if (visitor(full) === false) return;
      }
    }
  }
}
