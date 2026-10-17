/**
 * Shell tool. Executes a command in a sandboxed working directory and streams
 * stdout/stderr back to the caller. Destructive commands are routed through the
 * approval broker (see agent/approval-broker.ts) — this handler only runs after
 * the user has allowed it or the pattern is on the always-allow list.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BashArgs {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

/** Patterns that always require a human click (never auto-allowed). */
export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f?|[^-]\S*)\s+\/?(\*|\.\.\/?|~\/?|\/)/, // rm -rf style
  /\brm\s+(-[a-zA-Z]*f?|[^-]\S*)\s+-r/i, // rm -r
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/,
  /\bkill\s+-9\b/, /\bkillall\b/, /\bpkill\b/,
  /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\b/, /\bgit\s+checkout\b/,
  /\bchmod\s+777\b/, /\bchown\b/,
  /\bcurl\b.*\|\s*(sudo|bash|sh)\b/, /\bwget\b.*\|\s*(sudo|bash|sh)\b/,
  /\bsudo\b/, /\bsu\b/,
  /\bmount\b/, /\bumount\b/,
  /\bapt(-get)?\s+(install|remove|upgrade)\b/, /\byum\s+(install|remove)\b/, /\bdnf\s+(install|remove)\b/,
  /\bnpm\s+(install|ci|audit)\b/, /\byarn\s+add\b/, /\bpip\s+install\b/,
  /\bgit\s+init\b.*\./,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

export async function runBash(args: BashArgs): Promise<BashResult> {
  const cwd = args.cwd ?? process.cwd();
  mkdirSync(cwd, { recursive: true });
  const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
  const startedAt = Date.now();

  return await new Promise<BashResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn("bash", ["-c", args.command], {
      cwd,
      env: { ...process.env },
    }) as unknown as ChildProcessWithoutNullStreams;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n…[truncated]";
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n…[truncated]";
    });
    child.on("error", (error) => {
      stderr += `\n${error instanceof Error ? error.message : String(error)}`;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
