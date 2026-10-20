/**
 * The contract test between TypeScript and the fixture set that the Swift
 * client also decodes. If the daemon's wire shape drifts, this fails before a
 * user ever sees a bad frame.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  PROTOCOL_VERSION,
  decodeServerFrame,
  decisionTitle,
  encodeClientFrame,
  isKnownFrame,
  isUnknownFrame,
  parseClientFrame,
  stopReasonExplanation,
  type IncomingFrame,
  type ServerFrame,
} from "../src";

const fixtureURL = new URL("../../../packages/protocol/fixtures/frames.json", import.meta.url);

interface FixtureSet {
  protocolVersion: number;
  client: Array<Record<string, unknown>>;
  server: Array<Record<string, unknown>>;
}

function loadFixtures(): FixtureSet {
  return JSON.parse(readFileSync(fixtureURL, "utf8")) as FixtureSet;
}

function serverFrame(type: string): ServerFrame {
  const fixture = loadFixtures().server.find((frame) => frame.type === type);
  if (!fixture) throw new Error(`no ${type} fixture`);
  const decoded = decodeServerFrame(JSON.stringify(fixture));
  if (!decoded.ok) throw new Error(decoded.error);
  if (!isKnownFrame(decoded.frame)) throw new Error(`${type} decoded as unknown`);
  return decoded.frame;
}

describe("protocol fixtures", () => {
  test("fixtures cover the version and every shape this build knows", () => {
    const fixtures = loadFixtures();
    expect(fixtures.protocolVersion).toBe(PROTOCOL_VERSION);

    const clientTypes = new Set(fixtures.client.map((frame) => frame.type as string));
    for (const expected of [
      "hello",
      "resync",
      "msg.send",
      "msg.cancel",
      "approve.reply",
      "agent.select",
      "conversation.open",
      "session.new",
      "conversation.history",
      "thread.open",
      "thread.list",
      "thread.history",
      "job.list",
      "job.set",
      "task.list",
      "task.update",
    ]) {
      expect(clientTypes.has(expected), `no client fixture for ${expected}`).toBe(true);
    }

    const serverTypes = new Set(fixtures.server.map((frame) => frame.type as string));
    for (const expected of [
      "hello.ok",
      "token",
      "turn.start",
      "turn.end",
      "tool.start",
      "tool.update",
      "tool.end",
      "approval.request",
      "form.request",
      "notify",
      "agents.update",
      "thread.list.ok",
      "thread.history.ok",
      "conversation.ok",
      "session.start",
      "conversation.history.ok",
      "job.list.ok",
      "task.list.ok",
      "task.update.ok",
      "presence",
      "error",
    ]) {
      expect(serverTypes.has(expected), `no server fixture for ${expected}`).toBe(true);
    }
  });

  test("client fixtures decode and re-encode identically", () => {
    for (const object of loadFixtures().client) {
      const parsed = parseClientFrame(object);
      expect(parsed.ok, `${String(object.type)} did not parse`).toBe(true);
      if (!parsed.ok) continue;
      expect(JSON.parse(encodeClientFrame(parsed.frame))).toEqual(object);
    }
  });

  test("server fixtures decode with their wire seq", () => {
    for (const object of loadFixtures().server) {
      const decoded = decodeServerFrame(JSON.stringify(object));
      expect(decoded.ok, `${String(object.type)} did not decode`).toBe(true);
      if (!decoded.ok) continue;
      expect(decoded.frame.type).toBe(object.type);
      expect(decoded.frame.seq).toBe(object.seq);
      expect(isUnknownFrame(decoded.frame)).toBe(false);
    }
  });

  test("decoded fields match the wire", () => {
    const hello = serverFrame("hello.ok");
    expect(hello.type === "hello.ok" && hello.v).toBe(PROTOCOL_VERSION);

    const token = serverFrame("token");
    if (token.type === "token") {
      expect(token.delta).toBe("Call ");
      expect(token.turnID).toBe("trn_01hq");
    } else {
      throw new Error("wrong type");
    }

    const end = serverFrame("turn.end");
    if (end.type === "turn.end") {
      expect(end.stopReason).toBe("end");
      expect(end.usage?.latencyMs).toBe(412);
      expect(end.usage?.model).toBe("llama-3.1-8b-instant");
    } else {
      throw new Error("wrong type");
    }

    const approval = serverFrame("approval.request");
    if (approval.type === "approval.request") {
      expect(approval.buttons).toEqual(["once", "always", "reject"]);
      expect(approval.preview).toContain("git push origin main");
    } else {
      throw new Error("wrong type");
    }

    const form = serverFrame("form.request");
    if (form.type === "form.request") expect(form.options?.length).toBe(3);
    else throw new Error("wrong type");

    const notify = serverFrame("notify");
    if (notify.type === "notify") expect(notify.sound).toBe(true);
    else throw new Error("wrong type");

    const agents = serverFrame("agents.update");
    if (agents.type === "agents.update") {
      expect(agents.agents.length).toBe(2);
      expect(agents.agents[1]?.model).toBe("gemini-2.0-flash");
      expect(agents.agents[1]?.tools).toEqual(["links.search"]);
    } else {
      throw new Error("wrong type");
    }

    const threads = serverFrame("thread.list.ok");
    if (threads.type === "thread.list.ok") {
      expect(threads.threads.length).toBe(2);
      expect(threads.threads[1]?.title).toBeUndefined();
    } else {
      throw new Error("wrong type");
    }

    const history = serverFrame("thread.history.ok");
    if (history.type === "thread.history.ok") {
      expect(history.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(history.messages[1]?.turnID).toBe("trn_01hq");
    } else {
      throw new Error("wrong type");
    }

    const presence = serverFrame("presence");
    if (presence.type === "presence") expect(presence.state).toBe("offline");
    else throw new Error("wrong type");

    const error = serverFrame("error");
    if (error.type === "error") {
      expect(error.code).toBe("no_provider");
      expect(error.retryAfter).toBe(2);
    } else {
      throw new Error("wrong type");
    }
  });

  test("tool frames carry preview", () => {
    const end = serverFrame("tool.end");
    if (end.type === "tool.end") {
      expect(end.ok).toBe(true);
      expect(end.preview).toBe("3 matches");
    } else {
      throw new Error("wrong type");
    }
  });

  test("unknown server frame types are ignored, not fatal", () => {
    const decoded = decodeServerFrame(JSON.stringify({ type: "chart.render", seq: 99, whatever: 1 }));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(isUnknownFrame(decoded.frame)).toBe(true);
    expect(decoded.frame.type).toBe("chart.render");
    expect(decoded.frame.seq).toBe(99);
  });

  test("a known frame with a broken payload fails", () => {
    const token = decodeServerFrame(JSON.stringify({ type: "token", seq: 1, turnID: "trn_1" }));
    expect(token.ok).toBe(false);
    const hello = decodeServerFrame(JSON.stringify({ type: "hello.ok", seq: 1, v: 1, serverTime: "now" }));
    expect(hello.ok).toBe(false);
  });

  test("stop reasons and decisions survive unknown values", () => {
    expect(stopReasonExplanation("budget")).toBe("Out of budget");
    expect(stopReasonExplanation("paused")).toBe("paused");
    expect(stopReasonExplanation("end")).toBeNull();
    expect(decisionTitle("always")).toBe("Always allow");
    expect(decisionTitle("later")).toBe("later");
  });
});
