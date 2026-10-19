/**
 * Thread export. Two things are being pinned here: that the document contains
 * everything the owner would need to reconstruct a conversation (including the
 * tool calls and reasoning the chat deliberately hides), and that a message can
 * never become markup — an export is a document an owner may hand to someone
 * else, so escaping is a correctness property, not a nicety.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { appendChannelMessage } from "../src/stores/channels";
import { ensureConversation } from "../src/stores/conversations";
import { appendMessage, createThread, createTurn, finishTurn } from "../src/stores/threads";
import { buildShareDocument, publishShare, readShareFile, sharePath } from "../src/share/document";
import { escapeHTML, renderShareHTML, type ShareDocument } from "../src/share/render";

let db: Database | undefined;
const scratchDirs: string[] = [];
afterEach(() => {
  db?.close();
  db = undefined;
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.AGNI_SHARE_DIR;
});

function document(records: ShareDocument["records"]): ShareDocument {
  return {
    title: "Baahu — conversation",
    agentName: "Baahu",
    agentID: "ea",
    conversationID: "cnv_test",
    createdAt: "2026-10-19T12:00:00.000Z",
    records,
  };
}

describe("thread export renderer", () => {
  test("a message cannot become markup", () => {
    expect(escapeHTML(`<script>alert("x")</script> & 'quoted'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;",
    );
    const html = renderShareHTML({
      ...sampleDoc(),
      records: [
        { id: "m1", kind: "user", at: "2026-10-19T10:00:00.000Z", text: "<img src=x onerror=alert(1)>" },
        { id: "t1", kind: "tool", at: "2026-10-19T10:00:01.000Z", toolName: "bash", args: "\"><script>x</script>", result: "ok" },
      ],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // Self-contained: a shared file must not reach out for anything.
    expect(html).not.toMatch(/<(script|link|iframe)\b/);
  });

  test("records render in time order with the diagnostics the chat hides", () => {
    const html = renderShareHTML({
      ...sampleDoc(),
      records: [
        { id: "t1", kind: "tool", at: "2026-10-19T10:00:02.000Z", toolName: "web_search", args: "{\"query\":\"grok\"}", result: "3 results", ok: true, durationMs: 812 },
        { id: "a1", kind: "agent", at: "2026-10-19T10:00:03.000Z", agentID: "ea", agentName: "Baahu", text: "Found it." },
        { id: "u1", kind: "user", at: "2026-10-19T10:00:00.000Z", text: "who runs the grok bot?" },
        { id: "n1", kind: "notice", at: "2026-10-19T10:00:01.000Z", text: "Baahu → Researcher: find the grok bot" },
        { id: "k1", kind: "thinking", at: "2026-10-19T10:00:02.500Z", text: "The owner wants the operator, not the model." },
        { id: "p1", kind: "approval", at: "2026-10-19T10:00:04.000Z", text: "rm -rf build", decision: "reject" },
      ],
    });
    expect(html.indexOf("who runs the grok bot?")).toBeLessThan(html.indexOf("Baahu → Researcher"));
    expect(html.indexOf("Baahu → Researcher")).toBeLessThan(html.indexOf("web_search"));
    expect(html.indexOf("web_search")).toBeLessThan(html.indexOf("Found it."));
    expect(html).toContain("{&quot;query&quot;:&quot;grok&quot;}");
    expect(html).toContain("812ms");
    // Reasoning and the approval decision are both evidence, both rendered.
    expect(html).toContain("The owner wants the operator, not the model.");
    expect(html).toContain("rm -rf build — was denied.");
  });

  test("the same document renders identically twice", () => {
    const doc = sampleDoc();
    expect(renderShareHTML(doc)).toBe(renderShareHTML(doc));
  });

  test("counts describe the conversation, not the file", () => {
    const html = renderShareHTML({
      ...sampleDoc(),
      records: [
        { id: "u1", kind: "user", at: "2026-10-19T10:00:00.000Z", text: "hi" },
        { id: "a1", kind: "agent", at: "2026-10-19T10:00:01.000Z", text: "hello" },
        { id: "t1", kind: "tool", at: "2026-10-19T10:00:02.000Z", toolName: "bash", args: "{}", result: "", ok: true },
      ],
    });
    expect(html).toContain("2 messages");
    expect(html).toContain("1 tool call<");
  });
});

describe("thread export document", () => {
  test("reads the channel the conversation actually uses", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const thread = createThread(db, "ea", undefined, { conversationID: conversation.id });
    db.run(
      "INSERT INTO channels (id, name, agent_id, type, visibility, parent_turn_id, created_at, updated_at) VALUES ('dm:researcher', 'Researcher', 'researcher', 'dm', 'private', NULL, datetime('now'), datetime('now'))",
    );
    appendChannelMessage(db, { channelID: "main", fromType: "user", fromID: "user", text: "on the main channel" });
    appendChannelMessage(db, { channelID: "dm:researcher", fromType: "agent", fromID: "researcher", text: "on a dm channel" });

    const doc = buildShareDocument(db, { conversationID: conversation.id });
    expect(doc.records.some((record) => record.text === "on the main channel")).toBe(true);
    expect(doc.records.some((record) => record.text === "on a dm channel")).toBe(false);
    expect(doc.agentID).toBe("ea");
    expect(thread.conversation_id).toBe(conversation.id);
  });

  test("a specialist conversation reads its own dm channel", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "researcher");
    db.run(
      "INSERT INTO channels (id, name, agent_id, type, visibility, parent_turn_id, created_at, updated_at) VALUES ('dm:researcher', 'Researcher', 'researcher', 'dm', 'private', NULL, datetime('now'), datetime('now'))",
    );
    appendChannelMessage(db, { channelID: "dm:researcher", fromType: "user", fromID: "user", text: "dig into this" });
    appendChannelMessage(db, { channelID: "main", fromType: "user", fromID: "user", text: "unrelated" });

    const doc = buildShareDocument(db, { conversationID: conversation.id });
    expect(doc.records.map((record) => record.text)).toEqual(["dig into this"]);
    expect(doc.agentName).toBe("Researcher");
  });

  test("includes tool calls, approvals, unfinished turns, and reasoning", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const thread = createThread(db, "ea", undefined, { conversationID: conversation.id });
    const turn = "turn_export_1";
    createTurn(db, { id: turn, threadID: thread.id, agentID: "ea" });
    appendChannelMessage(db, { channelID: "main", fromType: "user", fromID: "user", text: "clean the build dir", turnID: turn });
    appendChannelMessage(db, {
      channelID: "main", fromType: "system", fromID: "ea", text: "Baahu → Coder: remove the build dir", uiHint: "handoff_notice", turnID: turn,
    });
    // The reply lands in the channel too; that is what anchors the reasoning
    // that produced it.
    appendChannelMessage(db, { channelID: "main", fromType: "agent", fromID: "ea", text: "Ran it.", turnID: turn });
    db.run(
      "INSERT INTO tool_calls (id, thread_id, turn_id, tool_name, args, result, ok, error, duration_ms, call_id, created_at) VALUES ('tc_1', ?, ?, 'bash', ?, ?, 1, NULL, 42, 'call_1', datetime('now'))",
      [thread.id, turn, "{\"command\":\"rm -rf build\"}", "removed"],
    );
    db.run(
      "INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, created_at, decided_at) VALUES ('apr_1', ?, ?, 'bash: rm -rf build', 'rm -rf build', 'decided', 'once', datetime('now'), datetime('now'))",
      [thread.id, turn],
    );
    appendMessage(db, { threadID: thread.id, turnID: turn, role: "assistant", text: "Ran it." });
    finishTurn(db, { id: turn, stopReason: "error" });
    db.run(
      "INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, summary, step_count, token_count, max_steps, max_tokens, created_at, updated_at) VALUES (?, ?, 'done', ?, NULL, 2, 10, 8, 1000, datetime('now'), datetime('now'))",
      [thread.id, turn, JSON.stringify([
        { role: "assistant", content: "", reasoning: "The owner said the build dir, so it is disposable." },
        { role: "assistant", content: "Ran it." },
      ])],
    );

    const doc = buildShareDocument(db, { conversationID: conversation.id });
    const kinds = doc.records.map((record) => record.kind);
    expect(kinds).toContain("tool");
    expect(kinds).toContain("approval");
    expect(kinds).toContain("notice");
    expect(kinds).toContain("thinking");
    const tool = doc.records.find((record) => record.kind === "tool");
    expect(tool?.toolName).toBe("bash");
    expect(tool?.result).toBe("removed");
    // The reasoning is anchored before the reply it produced.
    const thinkingIndex = doc.records.findIndex((record) => record.kind === "thinking");
    const answerIndex = doc.records.findIndex((record) => record.kind === "agent" && record.text === "Ran it.");
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    const thinkingAt = doc.records[thinkingIndex]?.at ?? "";
    const answerAt = doc.records[answerIndex]?.at ?? "";
    expect(thinkingAt < answerAt).toBe(true);
    // The errored turn is labelled rather than silently missing an answer.
    expect(doc.records.some((record) => record.code === "unfinished turn")).toBe(true);
    // Empty records never reach the document.
    expect(doc.records.every((record) => (record.text ?? "").trim().length > 0 || record.kind === "tool")).toBe(true);
  });

  test("an unknown conversation is an error, not an empty document", () => {
    db = openDatabase(":memory:");
    let message = "";
    try {
      buildShareDocument(db, { conversationID: "cnv_nope" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("unknown conversation");
  });

  test("a share token is a file name and nothing else", () => {
    expect(sharePath("../../etc/passwd")).toBeNull();
    expect(sharePath("0f3e8b1d4c2a9f6e0d3b7a1c5e9f2b4d")).toContain("0f3e8b1d4c2a9f6e0d3b7a1c5e9f2b4d.html");
  });

  test("publishing writes a file served by the daemon, and the token reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-share-"));
    process.env.AGNI_SHARE_DIR = dir;
    try {
      const published = publishShare(sampleDoc(), { baseURL: "http://127.0.0.1:8787/" });
      expect(published.url).toBe(`http://127.0.0.1:8787/share/${published.token}`);
      expect(published.path.startsWith(dir)).toBe(true);
      const written = readFileSync(published.path, "utf8");
      expect(readShareFile(published.token) === written).toBe(true);
      expect(readShareFile("00000000000000000000000000000000")).toBeNull();
      expect(readShareFile("../data/agni.sqlite")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sampleDoc(): ShareDocument {
  return {
    title: "Baahu — conversation",
    agentName: "Baahu",
    agentID: "ea",
    conversationID: "cnv_test",
    createdAt: "2026-10-19T09:00:00.000Z",
    records: [
      { id: "u1", kind: "user", at: "2026-10-19T08:59:00.000Z", text: "hello" },
      { id: "a1", kind: "agent", at: "2026-10-19T08:59:01.000Z", agentID: "ea", agentName: "Baahu", text: "hi" },
    ],
  };
}
