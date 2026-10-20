import { describe, expect, test } from "vitest";
import { cadence, count, latency, parseISO, preview, tokens, uptime } from "../src/format";
import { healthURL, websocketURL } from "../src/settings";

describe("formatting", () => {
  test("cadence reads like a person wrote it", () => {
    const noon = parseISO("2026-10-16T12:00:00.000Z");
    expect(cadence(60_000, noon)).toBe("Every 1 minute");
    expect(cadence(300_000, noon)).toBe("Every 5 minutes");
    expect(cadence(3_600_000, noon).startsWith("Every 1 hour")).toBe(true);
    expect(cadence(null, null)).toBe("Once");
  });

  test("machine values stay compact", () => {
    expect(latency(412)).toBe("412 ms");
    expect(latency(2400)).toBe("2.4 s");
    expect(tokens(940)).toBe("940");
    expect(tokens(12_400)).toBe("12.4k");
    expect(uptime(3_600_000 + 720_000)).toBe("1h 12m");
    expect(count(1, "turn")).toBe("1 turn");
    expect(count(3, "turn")).toBe("3 turns");
  });

  test("preview collapses whitespace", () => {
    expect(preview("line one\n\n  line two")).toBe("line one line two");
    expect(preview("x".repeat(200), 10).endsWith("…")).toBe(true);
    expect(Array.from(preview("x".repeat(200), 10)).length).toBe(11);
  });

  test("server addresses are accepted in the forms people type", () => {
    expect(websocketURL({ url: "127.0.0.1:8787" })).toBe("ws://127.0.0.1:8787/ws");
    expect(websocketURL({ url: "http://100.64.1.7:8787" })).toBe("ws://100.64.1.7:8787/ws");
    expect(websocketURL({ url: "wss://agni.example/ws" })).toBe("wss://agni.example/ws");
    expect(websocketURL({ url: "100.64.1.7" })).toBe("ws://100.64.1.7:8787/ws");
    expect(websocketURL({ url: "" })).toBeNull();
    expect(healthURL({ url: "127.0.0.1:8787" })).toBe("http://127.0.0.1:8787/health");
  });
});
