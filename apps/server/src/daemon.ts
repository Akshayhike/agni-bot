/**
 * Daemon lifecycle: run the server detached, find it again, stop it.
 *
 *   daemon start     spawn `serve` in its own session, wait for /health
 *   daemon stop      SIGTERM, escalate to SIGKILL only if it will not die
 *   daemon status    pid + health snapshot
 *   daemon logs      tail (or --follow) the daemon log
 *
 * State is two files: the pid file (written by `start`) and the log file the
 * detached process appends to. Everything else lives in SQLite and survives
 * either process. `serve` stays the foreground mode forever — launchd or
 * systemd can own it directly on bb-1 (`daemon run` semantics without files).
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config";
import { type HealthReport } from "./ws/server";
import { log } from "./log";

export interface PidInfo {
  pid: number;
  startedAt?: string;
}

export interface StartOutcome {
  ok: boolean;
  pid?: number;
  alreadyRunning?: boolean;
  health?: HealthReport;
  error?: string;
  logTail?: string[];
}

export interface StopOutcome {
  ok: boolean;
  pid?: number;
  message: string;
  forced?: boolean;
}

export interface StatusOutcome {
  running: boolean;
  /** Process alive but /health silent — booting or wedged. */
  unhealthy: boolean;
  pid?: number;
  stalePidFile: boolean;
  health?: HealthReport;
  pidPath: string;
  logPath: string;
}

export function pidFilePath(config: Config): string {
  return resolve(config.pidPath);
}

export function logFilePath(config: Config): string {
  return resolve(config.logPath);
}

export function healthURL(config: Config): string {
  return `http://${config.host}:${config.port}/health`;
}

export function readPidFile(path: string): PidInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; startedAt?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return {
      pid: parsed.pid,
      ...(typeof parsed.startedAt === "string" ? { startedAt: parsed.startedAt } : {}),
    };
  } catch {
    return null;
  }
}

export function writePidFile(path: string, info: PidInfo): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
}

export function removePidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone — the only outcome we wanted.
  }
}

/** True when the pid exists and signals can be delivered to it. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function fetchHealth(config: Config, timeoutMs = 1500): Promise<HealthReport | null> {
  try {
    const response = await fetch(healthURL(config), { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthReport;
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

export interface StartOptions {
  /** Path to the server entry point (defaults to this package's index.ts). */
  entryPath?: string;
  /** How long to wait for /health after spawning. */
  readyTimeoutMs?: number;
}

export async function startDaemon(config: Config, options: StartOptions = {}): Promise<StartOutcome> {
  const pidPath = pidFilePath(config);
  const logPath = logFilePath(config);

  const existing = readPidFile(pidPath);
  const healthy = await fetchHealth(config);
  if (healthy) {
    // Someone is already answering: adopt, do not double-start.
    return {
      ok: true,
      alreadyRunning: true,
      ...(existing ? { pid: existing.pid } : {}),
      health: healthy,
    };
  }
  if (existing && isProcessAlive(existing.pid)) {
    return {
      ok: false,
      pid: existing.pid,
      error: `pid ${existing.pid} is alive but /health did not answer — check the log`,
      logTail: tailLog(logPath, 20),
    };
  }
  if (existing) removePidFile(pidPath);

  const entryPath = options.entryPath ?? fileURLToPath(new URL("./index.ts", import.meta.url));
  const readyTimeoutMs = options.readyTimeoutMs ?? 10_000;
  mkdirSync(dirname(logPath), { recursive: true });

  const child = (() => {
    const logFd = openSync(logPath, "a");
    try {
      return Bun.spawn({
        cmd: [process.execPath, entryPath, "serve"],
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", logFd, logFd],
        // Own session: the daemon survives this shell, its signals stay its own.
        detached: true,
      });
    } finally {
      closeSync(logFd);
    }
  })();
  child.unref();
  writePidFile(pidPath, { pid: child.pid, startedAt: new Date().toISOString() });

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(child.pid)) {
      removePidFile(pidPath);
      return { ok: false, pid: child.pid, error: "server exited during startup", logTail: tailLog(logPath, 20) };
    }
    const health = await fetchHealth(config, 500);
    if (health) return { ok: true, pid: child.pid, health };
    await Bun.sleep(150);
  }
  return {
    ok: false,
    pid: child.pid,
    error: `no /health within ${readyTimeoutMs}ms — the process may still be booting`,
    logTail: tailLog(logPath, 20),
  };
}

export interface StopOptions {
  /** How long SIGTERM gets before SIGKILL. */
  timeoutMs?: number;
}

export async function stopDaemon(config: Config, options: StopOptions = {}): Promise<StopOutcome> {
  const pidPath = pidFilePath(config);
  const info = readPidFile(pidPath);
  if (!info || !isProcessAlive(info.pid)) {
    if (info) removePidFile(pidPath);
    return { ok: true, message: "not running" };
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (error) {
    removePidFile(pidPath);
    return { ok: false, pid: info.pid, message: `could not signal pid ${info.pid}: ${String(error)}` };
  }

  const timeoutMs = options.timeoutMs ?? 8_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(info.pid)) {
      removePidFile(pidPath);
      return { ok: true, pid: info.pid, message: `stopped (pid ${info.pid})` };
    }
    await Bun.sleep(100);
  }

  try {
    process.kill(info.pid, "SIGKILL");
  } catch {
    // Race: it died between the check and the kill.
  }
  await Bun.sleep(200);
  const alive = isProcessAlive(info.pid);
  if (!alive) removePidFile(pidPath);
  return {
    ok: !alive,
    pid: info.pid,
    forced: true,
    message: alive
      ? `pid ${info.pid} ignored SIGTERM and survived SIGKILL — investigate manually`
      : `pid ${info.pid} did not stop within ${timeoutMs}ms; SIGKILLed`,
  };
}

export async function daemonStatus(config: Config): Promise<StatusOutcome> {
  const pidPath = pidFilePath(config);
  const logPath = logFilePath(config);
  const info = readPidFile(pidPath);
  const health = await fetchHealth(config, 1500);
  if (health) {
    return {
      running: true,
      unhealthy: false,
      ...(info ? { pid: info.pid } : {}),
      stalePidFile: false,
      health,
      pidPath,
      logPath,
    };
  }
  if (info && isProcessAlive(info.pid)) {
    return { running: false, unhealthy: true, pid: info.pid, stalePidFile: false, pidPath, logPath };
  }
  if (info) removePidFile(pidPath);
  return { running: false, unhealthy: false, stalePidFile: Boolean(info), pidPath, logPath };
}

/** Last `lines` lines of a file; tolerates a missing or growing file. */
export function tailLog(path: string, lines: number, maxBytes = 128 * 1024): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8").split("\n").filter(Boolean).slice(-lines);
}

/** Print appended bytes as they land. Never returns — Ctrl+C exits. */
export async function followLog(path: string): Promise<never> {
  let position = 0;
  try {
    position = statSync(path).size;
  } catch {
    log.info(`waiting for ${path}…`);
  }
  for (;;) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // File rotated or not yet created.
    }
    if (size > position) {
      const buffer = Buffer.alloc(size - position);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buffer, 0, buffer.length, position);
      } finally {
        closeSync(fd);
      }
      process.stdout.write(buffer.toString("utf8"));
      position = size;
    } else if (size < position) {
      position = 0; // truncated/rotated
    }
    await Bun.sleep(250);
  }
}
