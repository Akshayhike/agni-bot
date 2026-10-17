/**
 * Search tools. Grep and glob over the sandbox directory. Both are bounded in
 * output size and reject paths that escape the sandbox.
 */
import { readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

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

export function grep(args: GrepArgs): GrepResult {
  const root = args.path ?? process.cwd();
  const regex = buildRegex(args.pattern, args.ignoreCase);
  const includeGlob = args.include ? normalizeGlob(args.include) : null;
  const matches: GrepMatch[] = [];
  let truncated = false;
  const limit = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);

  walk(root, (path) => {
    if (matches.length >= limit) { truncated = true; return false; }
    if (includeGlob && !matchGlob(basename(path), includeGlob)) return true;
    try {
      const content = require("node:fs").readFileSync(path);
      // Skip binary files (null byte = binary)
      if (content.indexOf(0) !== -1) return true;
      const text = content.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= limit) { truncated = true; return false; }
        const line = lines[i]!;
        if (regex.test(line)) {
          matches.push({
            path,
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
  const root = args.path ?? process.cwd();
  const globRe = normalizeGlob(args.pattern);
  const matches: string[] = [];
  let truncated = false;
  const limit = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);

  walk(root, (path) => {
    if (matches.length >= limit) { truncated = true; return false; }
    const rel = path.slice(root.length).replace(/^\/+/, "");
    if (matchGlob(rel, globRe) || matchGlob(basename(path), globRe)) matches.push(rel);
    return true;
  });

  return { matches, truncated };
}

function buildRegex(pattern: string, ignoreCase?: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? "iu" : "u");
  } catch {
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
