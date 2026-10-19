import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import { resolveApprovalWaiter } from "../src/agent/approval-broker";
import type { ResolvedPersona } from "../src/agent/personas";
import { createThread, createTurn } from "../src/stores/threads";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};
const taskPersona: ResolvedPersona = {
  id: "agni", name: "Agni", color: "#f0b95a", systemPromptTemplate: "Be helpful.", systemPrompt: "Be helpful.",
  tools: ["tasks_list"],
};
let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function streamResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  }), { status: 200 });
}

describe("task lane loop", () => {
  test("the model renaming the agent persists it and pushes agent.updated", async () => {
    db = openDatabase(":memory:");
    const persona = { ...taskPersona, tools: ["rename_agent"] };
    const thread = createThread(db, persona.id);
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      return request === 1
        ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "rename_agent", arguments: "{\"name\":\"Baahu\"}" } }] } }] }])
        : streamResponse([{ choices: [{ delta: { content: "Renamed to Baahu." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "I want to call you Baahu", persona,
      emit: (frame) => {
        emitted.push(frame as { type: string; [key: string]: unknown });
        // Renaming is approval-gated; answer the card the way the app does:
        // record the decision durably, then wake the waiter.
        if (frame.type === "approval.request") {
          db!.run("UPDATE approvals SET status = 'decided', decision = 'once', decided_at = ? WHERE id = ?", [
            new Date().toISOString(), String(frame.requestID),
          ]);
          resolveApprovalWaiter(String(frame.requestID), "once");
        }
      },
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("Renamed to Baahu.");
    expect(db.query<{ display_name: string }, []>("SELECT display_name FROM agents WHERE id = 'ea'").get()?.display_name).toBe("Baahu");
    expect(db.query("SELECT tool_name, ok FROM tool_calls WHERE turn_id = ?").get(result.turnID)).toEqual({ tool_name: "rename_agent", ok: 1 });
    const updated = emitted.find((frame) => frame.type === "agent.updated");
    expect(updated).toMatchObject({ agentId: "ea", displayName: "Baahu", onboarded: true });
    expect(emitted.find((frame) => frame.type === "approval.request")).toMatchObject({ action: "rename the assistant to Baahu" });
  });

  test("executes a store tool, observes its result, and returns a final response", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    const requestBodies: Array<Record<string, unknown>> = [];
    let request = 0;
    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      request += 1;
      return request === 1
        ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "tasks_list", arguments: "{\"status\":\"open\",\"limit\":5}" } }] } }] }])
        : streamResponse([{ choices: [{ delta: { content: "You have no open tasks." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "What tasks do I have?", persona: taskPersona,
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }), signal: new AbortController().signal,
    });

    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("You have no open tasks.");
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.tools).toHaveLength(1);
    expect(requestBodies[0]?.tool_choice).toBe("auto");
    expect((requestBodies[1]?.messages as Array<Record<string, unknown>>).some((message) => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
    expect(db.query("SELECT tool_name, ok FROM tool_calls WHERE turn_id = ?").get(result.turnID)).toEqual({ tool_name: "tasks_list", ok: 1 });
    expect(db.query("SELECT state FROM agent_sessions WHERE thread_id = ?").get(thread.id)).toEqual({ state: "done" });
  });

  test("keeps generic shell and file tools outside the task allowlist", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    const registry = new Router([provider], new HealthTracker(), (async () => streamResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-shell", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo no\"}" } }] } }] },
    ])) as unknown as typeof fetch);
    const result = await runTaskTurn(db, registry, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "Run a command", persona: taskPersona,
      emit: () => undefined, signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("end");
    expect(db.query<{ result: string }, [string]>("SELECT result FROM tool_calls WHERE turn_id = ?").get(result.turnID)?.result).toContain("not available");
  });

  test("recovers an interrupted session without replaying an uncertain tool side effect", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    const oldTurnID = "trn_interrupted";
    createTurn(db, { id: oldTurnID, threadID: thread.id, agentID: taskPersona.id });
    const log = [
      { role: "user", content: "Add a task" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-uncertain", type: "function", function: { name: "task_create", arguments: "{\\\"title\\\":\\\"Do not duplicate\\\"}" } }] },
    ];
    db.run("INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, max_steps, max_tokens, created_at, updated_at) VALUES (?, ?, 'running', ?, 8, 16000, datetime('now'), datetime('now'))", [thread.id, oldTurnID, JSON.stringify(log)]);
    db.run("INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, created_at) VALUES ('tcl_interrupted', ?, ?, 'call-uncertain', 'task_create', '{\"title\":\"Do not duplicate\"}', NULL, 0, datetime('now'))", [thread.id, oldTurnID]);

    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([{ choices: [{ delta: { content: "I resumed. Please retry that task action if needed." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "Continue", persona: taskPersona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    const sentMessages = requestBody?.messages as Array<{ role: string; content: string }>;
    expect(result.turnID).toBe(oldTurnID);
    expect(sentMessages.some((message) => message.role === "tool" && message.content.includes("was not repeated"))).toBe(true);
    expect(db.query("SELECT count(*) AS count FROM tasks").get()).toEqual({ count: 0 });
    expect(db.query<{ state: string }, [string]>("SELECT state FROM agent_sessions WHERE thread_id = ?").get(thread.id)?.state).toBe("done");
  });
});
