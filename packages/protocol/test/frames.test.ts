import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  decodeText,
  encodeFrame,
  isSupportedVersion,
  parseClientFrame,
  parseServerFrame,
} from "../src/index";

describe("client frames", () => {
  test("accepts a full msg.send", () => {
    const result = parseClientFrame({
      type: "msg.send",
      threadID: "thr_1",
      text: "hello",
      files: ["a.png"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe("msg.send");
      if (result.frame.type === "msg.send") expect(result.frame.text).toBe("hello");
    }
  });

  test("accepts empty threadID as new-thread signal", () => {
    const result = parseClientFrame({ type: "msg.send", threadID: "", text: "hi" });
    expect(result.ok).toBe(true);
  });

  test("rejects missing text", () => {
    const result = parseClientFrame({ type: "msg.send", threadID: "thr_1" });
    expect(result.ok).toBe(false);
  });

  test("rejects unknown frame types", () => {
    const result = parseClientFrame({ type: "msg.explode", threadID: "thr_1" });
    expect(result.ok).toBe(false);
  });

  test("rejects a bad decision token", () => {
    const result = parseClientFrame({ type: "approve.reply", requestID: "req_1", decision: "maybe" });
    expect(result.ok).toBe(false);
  });

  test("accepts hello with a version", () => {
    const result = parseClientFrame({ type: "hello", v: PROTOCOL_VERSION, token: "agni_x", device: "cli" });
    expect(result.ok).toBe(true);
  });
});

describe("server frames", () => {
  test("accepts hello.ok with seq", () => {
    const result = parseServerFrame({
      type: "hello.ok",
      seq: 1,
      v: PROTOCOL_VERSION,
      serverTime: "2026-10-16T12:00:00.000Z",
      lastSeq: 1,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects server frames without seq", () => {
    const result = parseServerFrame({ type: "presence", state: "online" });
    expect(result.ok).toBe(false);
  });

  test("accepts turn.end with usage", () => {
    const result = parseServerFrame({
      type: "turn.end",
      seq: 9,
      turnID: "trn_1",
      threadID: "thr_1",
      stopReason: "end",
      usage: { provider: "groq", model: "llama-3.1-8b-instant", latencyMs: 412 },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects unknown stop reason", () => {
    const result = parseServerFrame({
      type: "turn.end",
      seq: 9,
      turnID: "trn_1",
      threadID: "thr_1",
      stopReason: "exploded",
    });
    expect(result.ok).toBe(false);
  });
});

describe("envelope helpers", () => {
  test("encode → decode → parse round trip", () => {
    const wire = encodeFrame({ type: "msg.cancel", turnID: "trn_1" });
    const decoded = decodeText(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const parsed = parseClientFrame(decoded.value);
      expect(parsed.ok).toBe(true);
    }
  });

  test("decodeText reports invalid JSON", () => {
    expect(decodeText("{oops").ok).toBe(false);
  });

  test("version guard", () => {
    expect(isSupportedVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedVersion(PROTOCOL_VERSION - 1)).toBe(false);
  });
});
