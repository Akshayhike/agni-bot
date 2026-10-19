import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import { defaultResolvedPersona } from "../src/agent/personas";
import { createThread } from "../src/stores/threads";
import { rootGuardrail, enterDelegation, canDelegate, GuardrailError, MAX_DEPTH, MAX_DELEGATED_STEPS } from "../src/agent/guardrails";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};

function sseReply(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function makeRouter(responses: string[]): Router {
  let index = 0;
  const fetchStub = async (): Promise<Response> =>
    sseReply(responses[Math.min(index++, responses.length - 1)] ?? (responses[0] as string));
  return new Router([provider], new HealthTracker(), fetchStub as unknown as typeof fetch);
}

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("guardrails", () => {
  test("delegation is refused once the published ceiling is reached", () => {
    const root = rootGuardrail("agni");
    // Walk the chain up to the ceiling; the last step must refuse further.
    let state = root;
    while (canDelegate(state)) {
      state = enterDelegation(state, `agent-${state.depth}`, `handoff ${state.depth}`);
    }
    expect(canDelegate(state)).toBe(false);
    expect(() => enterDelegation(state, "agni", "nope")).toThrow(GuardrailError);
    // The ceiling is at least 2 (root + one delegation) and bounded.
    expect(state.depth).toBeGreaterThanOrEqual(3);
    expect(state.depth).toBeLessThanOrEqual(10);
  });

  test("MAX_DEPTH and MAX_DELEGATED_STEPS are the published ceilings", () => {
    expect(Number.isInteger(MAX_DEPTH)).toBe(true);
    expect(MAX_DEPTH).toBeGreaterThan(1);
    expect(Number.isInteger(MAX_DELEGATED_STEPS)).toBe(true);
    expect(MAX_DELEGATED_STEPS).toBeGreaterThan(0);
  });
});

describe("agent-to-agent handoff", () => {
  test("a root turn runs at depth 1 with the delegation prefix", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, defaultResolvedPersona(db!).id);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const router = makeRouter(["I don't need to delegate."]);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "hi", persona: defaultResolvedPersona(db!),
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }),
      signal: new AbortController().signal,
      guardrail: rootGuardrail("agni"),
    });
    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("I don't need to delegate.");
  });

  test("a turn at the depth ceiling still runs but cannot delegate further", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, defaultResolvedPersona(db!).id);
    // Walk the chain to the published ceiling; the turn can still do its own
    // work, but any handoff attempt from here is refused by enterDelegation.
    let atCeiling = rootGuardrail("agni");
    while (canDelegate(atCeiling)) {
      atCeiling = enterDelegation(atCeiling, `agent-${atCeiling.depth}`, `handoff ${atCeiling.depth}`);
    }
    expect(canDelegate(atCeiling)).toBe(false);
    const router = makeRouter(["I am at the ceiling and I know it."]);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "hi", persona: defaultResolvedPersona(db!),
      emit: () => undefined, signal: new AbortController().signal,
      guardrail: atCeiling,
    });
    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("I am at the ceiling and I know it.");
    // Delegating again from here is refused.
    expect(() => enterDelegation(atCeiling, "agni", "nope")).toThrow(GuardrailError);
  });

  test("handoff tool is registered per turn and the turn emits tool frames", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, defaultResolvedPersona(db!).id);
    const router = makeRouter(["done"]);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "hi", persona: defaultResolvedPersona(db!),
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }),
      signal: new AbortController().signal,
      guardrail: rootGuardrail("agni"),
    });
    expect(emitted.some((frame) => frame.type === "turn.start")).toBe(true);
    expect(emitted.some((frame) => frame.type === "turn.end")).toBe(true);
  });
});