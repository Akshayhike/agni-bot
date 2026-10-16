import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive, readPidFile, removePidFile, tailLog, writePidFile } from "../src/daemon";
import { formatDuration, parseDurationMs, parseWhen } from "../src/util/time";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agni-test-"));
}

describe("pid files", () => {
  test("round-trip, tolerate junk, and remove cleanly", () => {
    const path = join(tempDir(), "agni.pid");
    expect(readPidFile(path)).toBeNull();

    writePidFile(path, { pid: 4242, startedAt: "2026-10-16T12:00:00.000Z" });
    expect(readPidFile(path)).toEqual({ pid: 4242, startedAt: "2026-10-16T12:00:00.000Z" });

    writeFileSync(path, "not json at all");
    expect(readPidFile(path)).toBeNull();

    writeFileSync(path, JSON.stringify({ pid: "nope" }));
    expect(readPidFile(path)).toBeNull();

    removePidFile(path);
    expect(readPidFile(path)).toBeNull();
    removePidFile(path); // idempotent
  });

  test("isProcessAlive finds a live process and misses a dead one", async () => {
    expect(isProcessAlive(process.pid)).toBe(true);

    const child = Bun.spawn({ cmd: [process.execPath, "-e", "/* exits immediately */"] });
    const pid = child.pid;
    await child.exited;
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe("log tail", () => {
  test("returns the last lines and tolerates a missing file", () => {
    const path = join(tempDir(), "agni.log");
    expect(tailLog(path, 10)).toEqual([]);

    const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(tailLog(path, 3)).toEqual(["line 48", "line 49", "line 50"]);
  });
});

describe("time helpers", () => {
  test("parses compact durations", () => {
    expect(parseDurationMs("45s")).toBe(45_000);
    expect(parseDurationMs("10m")).toBe(600_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
    expect(parseDurationMs("1500")).toBe(1_500);
    expect(parseDurationMs("2.5m")).toBe(150_000);
    expect(parseDurationMs("soon")).toBeNull();
    expect(parseDurationMs("0m")).toBeNull();
  });

  test("parses ISO timestamps and unix milliseconds", () => {
    expect(parseWhen("2026-10-16T21:00:00.000Z")).toBe("2026-10-16T21:00:00.000Z");
    expect(parseWhen("1776370800000")).toBe(new Date(1_776_370_800_000).toISOString());
    expect(parseWhen("not a time")).toBeNull();
  });

  test("formats durations for humans", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
    expect(formatDuration(90_000_000)).toBe("1d 01h");
  });
});
