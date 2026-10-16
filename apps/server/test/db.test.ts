import { describe, expect, test } from "bun:test";
import { mintToken, revokeDevice, verifyToken } from "../src/auth/tokens";
import { openDatabase, readMeta, writeMeta } from "../src/db";
import {
  appendMessage,
  createThread,
  createTurn,
  finishTurn,
  getThread,
  recentMessages,
} from "../src/stores/threads";

function freshDb() {
  return openDatabase(":memory:");
}

describe("migrations", () => {
  test("create the full schema, FTS5 included", () => {
    const db = freshDb();
    const names = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((row) => row.name);
    for (const table of [
      "devices",
      "threads",
      "turns",
      "messages",
      "usage_ledger",
      "approvals",
      "tasks",
      "links",
      "memories",
      "jobs",
      "memories_fts",
      "links_fts",
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  test("write-time indexes are searchable (S2/S4)", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO memories (id, text, summary, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["mem_1", "my passport expires in March 2029", "passport expiry Mar 2029", "travel", "now", "now"],
    );
    db.run("INSERT INTO memories_fts (id, text, summary) VALUES (?, ?, ?)", [
      "mem_1",
      "my passport expires in March 2029",
      "passport expiry Mar 2029",
    ]);
    const rows = db
      .query<{ id: string }, [string]>("SELECT id FROM memories_fts WHERE memories_fts MATCH ?")
      .all("passport");
    expect(rows.map((row) => row.id)).toEqual(["mem_1"]);
    db.close();
  });

  test("meta round trip", () => {
    const db = freshDb();
    expect(readMeta(db, "seq")).toBeNull();
    writeMeta(db, "seq", "42");
    writeMeta(db, "seq", "43");
    expect(readMeta(db, "seq")).toBe("43");
    db.close();
  });
});

describe("device tokens", () => {
  test("mint → verify → revoke", async () => {
    const db = freshDb();
    const { device, token } = await mintToken(db, "cli-test");
    expect(token.startsWith("agni_")).toBe(true);

    const verified = await verifyToken(db, token);
    expect(verified?.id).toBe(device.id);

    const bogus = await verifyToken(db, "agni_not-a-real-token");
    expect(bogus).toBeNull();

    const revoked = revokeDevice(db, device.id.slice(0, 12)); // prefix match
    expect(revoked?.id).toBe(device.id);
    expect(await verifyToken(db, token)).toBeNull();
    db.close();
  });
});

describe("thread store", () => {
  test("message order survives same-millisecond writes", () => {
    const db = freshDb();
    const thread = createThread(db, "agni", " ");
    expect(getThread(db, thread.id)?.id).toBe(thread.id);

    appendMessage(db, { threadID: thread.id, role: "user", text: "one" });
    appendMessage(db, { threadID: thread.id, role: "assistant", text: "two" });
    appendMessage(db, { threadID: thread.id, role: "user", text: "three" });

    const recent = recentMessages(db, thread.id, 2);
    expect(recent.map((message) => message.text)).toEqual(["two", "three"]);
    db.close();
  });

  test("turn lifecycle persists stop reason and usage", () => {
    const db = freshDb();
    const thread = createThread(db, "agni");
    const turnID = "trn_test";
    createTurn(db, { id: turnID, threadID: thread.id, agentID: "agni" });
    finishTurn(db, { id: turnID, stopReason: "end", provider: "groq", model: "fast-small", latencyMs: 412 });

    const row = db
      .query<{ state: string; stop_reason: string; provider: string }, [string]>(
        "SELECT state, stop_reason, provider FROM turns WHERE id = ?",
      )
      .get(turnID);
    expect(row).toMatchObject({ state: "done", stop_reason: "end", provider: "groq" });
    db.close();
  });
});
