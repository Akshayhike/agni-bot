#!/usr/bin/env bun
/**
 * Mock OpenAI-compatible provider — the keyless way to run the P0 proof
 * (bench, failover, streaming) and to exercise CI without real providers.
 *
 *   bun run mock                                  healthy stream on :9911
 *   MOCK_PORT=9912 MOCK_FAIL=1 bun run mock       429s everything (failover fixture)
 *   MOCK_DELAY_MS=50 bun run mock                  adds inter-token latency
 */
const port = Number.parseInt(Bun.env.MOCK_PORT ?? "9911", 10);
const shouldFail = Bun.env.MOCK_FAIL === "1";
const delayMs = Number.parseInt(Bun.env.MOCK_DELAY_MS ?? "5", 10);
const model = Bun.env.MOCK_MODEL ?? "mock-model";

const encoder = new TextEncoder();

function sse(delta: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/chat/completions") && request.method === "POST") {
      if (shouldFail) {
        return new Response(JSON.stringify({ error: { message: "mock: rate limited" } }), {
          status: 429,
          headers: { "retry-after": "2", "content-type": "application/json" },
        });
      }
      const body = (await request.json().catch(() => ({}))) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
      const reply = `mock(${model}): ${lastUser?.content ?? "no input"}`;
      const words = reply.split(" ");
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await Bun.sleep(delayMs);
          for (const word of words) {
            controller.enqueue(sse(`${word} `));
            if (delayMs > 0) await Bun.sleep(delayMs);
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: {} }],
                usage: { prompt_tokens: 10, completion_tokens: words.length },
              })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ ok: true, port, fail: shouldFail, model });
  },
});

console.log(`mock provider on http://127.0.0.1:${server.port}/v1 (fail=${shouldFail}, model=${model})`);
