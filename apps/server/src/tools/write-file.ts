/**
 * File write tool. Writes content into the sandbox directory, creating parent
 * directories as needed. Writes outside the sandbox are rejected.
 */
import { mkdirSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";

const SANDBOX_DIR = process.env.AGNI_SANDBOX_DIR ?? join(tmpdir(), "agni-sandbox");
const MAX_BYTES = 1024 * 1024;

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

export function resolveSandboxPath(relativePath: string): string {
  const base = realpathSync(SANDBOX_DIR);
  const target = resolve(base, relativePath);
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel === "..") throw new Error("path escapes the sandbox directory");
  return target;
}

export function writeFile(args: WriteFileArgs): WriteFileResult {
  if (args.content.length > MAX_BYTES) throw new Error("content exceeds 1 MB");
  const target = resolveSandboxPath(args.path);
  let created = false;
  try { statSync(target); } catch { created = true; }
  mkdirSync(join(target, ".."), { recursive: true });
  if (args.append) {
    const existing = created ? "" : require("node:fs").readFileSync(target, "utf8");
    writeFileSync(target, existing + args.content, { flag: "w" });
  } else {
    writeFileSync(target, args.content, { flag: "w" });
  }
  return { path: args.path, bytesWritten: args.content.length, created };
}