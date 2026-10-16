import { describe, expect, test } from "bun:test";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { MidStreamError, Router, RouterError } from "../src/models/router";

const groq: ProviderConfig = {
  id: "groq",
  label: "Groq",
  baseUrl: "https://groq.test/v1",
  apiKey: "test-key",
  model: "fast-small",
  tiers: ["instant"],
};

const nim: ProviderConfig = {
  id: "nim",
  label: "NIM",
  baseUrl: "https://nim.test/v1",
  apiKey: "test-key",
  model: "big",
  tiers: ["instant", "task", "deep"],
};

const encoder = new TextEncoder();

function sseEvent(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

function sseResponse(...deltas: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of deltas) controller.enqueue(encoder.encode(sseEvent(delta)));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Emits one delta, then the stream errors mid-flight. */
function erroringStream(delta: string): Response {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 0) {
        pulled += 1;
        controller.enqueue(encoder.encode(sseEvent(delta)));
        return;
      }
      controller.error(new Error("network blip"));
    },
  });
  return new Response(stream, { status: 200 });
}

/** Never emits; errors only when the caller aborts (first-token timeout). */
function hangingResponse(init: RequestInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      init.signal?.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"));
      });
    },
  });
  return new Response(stream, { status: 200 });
}

const baseOptions = {
  tier: "instant" as const,
  messages: [{ role: "user" as const, content: "hi" }],
  firstTokenTimeoutMs: 1000,
};

describe("router", () => {
  test("fails over to the next provider on 429 and cools the failed one down", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("groq.test")) {
        return new Response("rate limited", { status: 429, headers: { "retry-after": "1" } });
      }
      return sseResponse("hello", " world");
    }) as unknown as typeof fetch;

    const health = new HealthTracker();
    const router = new Router([groq, nim], health, fetchFn);
    const deltas: string[] = [];
    const result = await router.route({ ...baseOptions, onDelta: (delta) => deltas.push(delta) });

    expect(result.provider).toBe("nim");
    expect(result.attempts).toBe(2);
    expect(result.text).toBe("hello world");
    expect(deltas.join("")).toBe("hello world");
    expect(health.isAvailable("groq")).toBe(false);

    // A second request skips the cooling provider entirely.
    calls.length = 0;
    await router.route({ ...baseOptions, onDelta: () => {} });
    expect(calls.some((url) => url.includes("groq.test"))).toBe(false);
    expect(calls.some((url) => url.includes("nim.test"))).toBe(true);
  });

  test("fails over on first-token timeout", async () => {
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.includes("groq.test")) return hangingResponse(init ?? {});
      return sseResponse("quick");
    }) as unknown as typeof fetch;

    const router = new Router([groq, nim], new HealthTracker(), fetchFn);
    const result = await router.route({ ...baseOptions, firstTokenTimeoutMs: 50, onDelta: () => {} });
    expect(result.provider).toBe("nim");
    expect(result.attempts).toBe(2);
  });

  test("does not fail over after tokens were emitted (no duplicated text)", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("groq.test")) return erroringStream("partial");
      return sseResponse("should not happen");
    }) as unknown as typeof fetch;

    const router = new Router([groq, nim], new HealthTracker(), fetchFn);
    const deltas: string[] = [];
    await expect(router.route({ ...baseOptions, onDelta: (delta) => deltas.push(delta) })).rejects.toBeInstanceOf(
      MidStreamError,
    );
    expect(deltas.join("")).toBe("partial");
    expect(calls.some((url) => url.includes("nim.test"))).toBe(false);
  });

  test("reports no_provider when nothing is configured", async () => {
    const router = new Router([], new HealthTracker());
    const failure = router.route({ ...baseOptions, onDelta: () => {} });
    await expect(failure).rejects.toBeInstanceOf(RouterError);
    await expect(failure.catch((error: RouterError) => error.code)).resolves.toBe("no_provider");
  });

  test("reports provider_failed when every candidate fails", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const router = new Router([groq, nim], new HealthTracker(), fetchFn);
    await expect(router.route({ ...baseOptions, onDelta: () => {} })).rejects.toMatchObject({
      code: "provider_failed",
    });
  });
});
