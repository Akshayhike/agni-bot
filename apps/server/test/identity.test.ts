import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { MAX_AGENT_NAME_CHARS, normalizeAgentName, renameAgent } from "../src/agent/identity";
import { resolvePersona } from "../src/agent/personas";

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function displayName(database: Database, agentID: string): string | null {
  return database
    .query<{ display_name: string | null }, [string]>("SELECT display_name FROM agents WHERE id = ?")
    .get(agentID)?.display_name ?? null;
}

describe("agent rename", () => {
  test("collapses whitespace and rejects names that break the frame contract", () => {
    expect(normalizeAgentName("  Baahu   Bot ")).toBe("Baahu Bot");
    expect(normalizeAgentName("two\nlines")).toBe("two lines");
    expect(normalizeAgentName("tab\tsep")).toBe("tab sep");
    expect(normalizeAgentName("nul\0byte")).toBeNull();
    expect(normalizeAgentName("")).toBeNull();
    expect(normalizeAgentName("   ")).toBeNull();
    expect(normalizeAgentName("a".repeat(MAX_AGENT_NAME_CHARS + 1))).toBeNull();
    expect(normalizeAgentName("a".repeat(MAX_AGENT_NAME_CHARS))).toHaveLength(MAX_AGENT_NAME_CHARS);
  });

  test("persists the new name, marks onboarding done, and reports the old one", () => {
    db = openDatabase(":memory:");
    const result = renameAgent(db, "ea", "  Baahu  ");
    expect(result).toEqual({ ok: true, agentID: "ea", previousName: "Agni Bot", name: "Baahu" });
    expect(displayName(db, "ea")).toBe("Baahu");
    expect(db.query<{ onboarded: number }, []>("SELECT onboarded FROM agents WHERE id = 'ea'").get()?.onboarded).toBe(1);
  });

  test("a rename reaches the model through persona resolution", () => {
    db = openDatabase(":memory:");
    expect(resolvePersona(db, "ea")?.systemPrompt.split("\n")[0]).toBe(
      "You are Agni Bot, personal assistant to the owner.",
    );
    renameAgent(db, "ea", "Baahu");
    expect(resolvePersona(db, "ea")?.systemPrompt.split("\n")[0]).toBe(
      "You are Baahu, personal assistant to the owner.",
    );
  });

  test("the legacy agni alias resolves to the same agent and stays in step", () => {
    db = openDatabase(":memory:");
    const result = renameAgent(db, "agni", "Baahu");
    expect(result.ok && result.agentID).toBe("ea");
    expect(displayName(db, "ea")).toBe("Baahu");
    expect(displayName(db, "agni")).toBe("Baahu");
    expect(resolvePersona(db, "agni")?.name).toBe("Baahu");
  });

  test("an unknown agent is refused without writing anything", () => {
    db = openDatabase(":memory:");
    const result = renameAgent(db, "nobody", "Baahu");
    expect(result.ok).toBe(false);
    expect(displayName(db, "ea")).toBe("Agni Bot");
  });

  test("an invalid name leaves the stored name untouched", () => {
    db = openDatabase(":memory:");
    const result = renameAgent(db, "ea", "  ");
    expect(result.ok).toBe(false);
    expect(displayName(db, "ea")).toBe("Agni Bot");
  });
});
