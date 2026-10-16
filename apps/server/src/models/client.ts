/**
 * Minimal streaming client for OpenAI-compatible `chat/completions`.
 * Every provider in the catalog speaks this shape, so this file is the only
 * place that knows how to talk to a model endpoint.
 */
import { log } from "../log";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ProviderErrorKind = "http" | "network" | "timeout" | "aborted" | "parse";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { kind: ProviderErrorKind; status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "ProviderError";
    this.kind = options.kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** Abort the attempt if no content token arrives within this window. */
  firstTokenTimeoutMs: number;
  onDelta: (delta: string) => void;
  temperature?: number;
  maxTokens?: number;
  fetchFn?: typeof fetch;
}

export interface ChatResult {
  text: string;
  firstTokenMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Parse an HTTP Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export async function streamChat(request: ChatRequest): Promise<ChatResult> {
  const fetchFn = request.fetchFn ?? fetch;
  const url = `${request.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  let timedOut = false;
  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;

  const abortFromCaller = (): void => controller.abort();
  if (request.signal) {
    if (request.signal.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
    request.signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  const cleanup = (): void => {
    if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
    request.signal?.removeEventListener("abort", abortFromCaller);
  };

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    cleanup();
    if (request.signal?.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
    throw new ProviderError(`request failed: ${messageOf(error)}`, { kind: "network" });
  }

  if (!response.ok) {
    cleanup();
    const body = await response.text().catch(() => "");
    throw new ProviderError(`HTTP ${response.status}: ${truncate(body, 300)}`, {
      kind: "http",
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
  if (!response.body) {
    cleanup();
    throw new ProviderError("response has no body", { kind: "network" });
  }

  firstTokenTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.firstTokenTimeoutMs);

  const startedAt = Date.now();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let firstTokenMs = -1;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    // SSE: one JSON event per `data:` line, terminated by `data: [DONE]`.
    streamLoop: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payloadText = line.slice("data:".length).trim();
        if (payloadText === "[DONE]") break streamLoop;
        let payload: unknown;
        try {
          payload = JSON.parse(payloadText);
        } catch {
          continue; // keep-alive comments and partial junk are not fatal
        }
        const choice = (payload as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          if (firstTokenMs < 0) {
            firstTokenMs = Date.now() - startedAt;
            if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
          }
          text += delta;
          request.onDelta(delta);
        }
        const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? outputTokens;
        }
      }
    }
  } catch (error) {
    if (timedOut) throw new ProviderError(`no first token within ${request.firstTokenTimeoutMs}ms`, { kind: "timeout" });
    if (request.signal?.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
    throw new ProviderError(`stream failed: ${messageOf(error)}`, { kind: "network" });
  } finally {
    cleanup();
    reader.releaseLock?.();
  }

  if (firstTokenMs < 0) {
    // The stream ended without a single content token.
    log.debug(`provider returned no content tokens for model ${request.model}`);
    firstTokenMs = Date.now() - startedAt;
  }
  return { text, firstTokenMs, inputTokens, outputTokens };
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
