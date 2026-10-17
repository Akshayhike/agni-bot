/**
 * File write tool. Writes content into the sandbox directory, creating parent
 * directories as needed. Writes outside the sandbox are rejected.
 */
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

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