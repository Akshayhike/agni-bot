/**
 * Model router — free-first, failover on 429/timeout, and honest about the
 * one case it cannot fix: a stream that already emitted tokens is not retried
 * on another provider (that would duplicate text into the thread).
 */
import { ProviderError, streamChat, type ChatMessage } from "./client";
import type { HealthTracker } from "./health";
import { TIER_ORDER, type ProviderConfig, type Tier } from "./providers";
import { log } from "../log";

export class RouterError extends Error {
  readonly code: "no_provider" | "provider_failed";

  constructor(code: "no_provider" | "provider_failed", message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}

/** A provider failed after tokens were already emitted to the client. */
export class MidStreamError extends Error {
  readonly provider: string;

  constructor(provider: string, cause: ProviderError) {
    super(`${provider} failed mid-stream: ${cause.message}`);
    this.name = "MidStreamError";
    this.provider = provider;
  }
}

export interface RouteOptions {
  tier: Tier;
  messages: ChatMessage[];
  signal?: AbortSignal;
  firstTokenTimeoutMs: number;
  onDelta: (delta: string) => void;
}

export interface RouteResult {
  provider: string;
  model: string;
  text: string;
  firstTokenMs: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  attempts: number;
}

export interface ProviderStatus {
  id: string;
  label: string;
  model: string;
  tiers: Tier[];
  available: boolean;
  cooldownRemainingMs: number;
  lastError?: string;
  lastSuccessAt?: number;
}

export class Router {
  constructor(
    private readonly providers: ProviderConfig[],
    private readonly health: HealthTracker,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Configured providers for a tier, healthiest first, cooling ones last. */
  candidates(tier: Tier): ProviderConfig[] {
    const order = TIER_ORDER[tier];
    const rank = new Map(order.map((id, index) => [id, index]));
    const eligible = this.providers
      .filter((provider) => provider.tiers.includes(tier))
      .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    const healthy = eligible.filter((provider) => this.health.isAvailable(provider.id));
    const cooling = eligible.filter((provider) => !this.health.isAvailable(provider.id));
    // Cooling providers stay in the list as a last resort — a spent cooldown
    // beats a hard failure when nothing else is configured.
    return [...healthy, ...cooling];
  }

  async route(options: RouteOptions): Promise<RouteResult> {
    const candidates = this.candidates(options.tier);
    if (candidates.length === 0) {
      throw new RouterError(
        "no_provider",
        "no model providers configured for the instant lane — set GROQ_API_KEY, CEREBRAS_API_KEY, or NVIDIA_API_KEY in .env",
      );
    }

    const errors: string[] = [];
    let attempts = 0;
    for (const provider of candidates) {
      attempts += 1;
      const beganAt = Date.now();
      let emitted = false;
      try {
        const result = await streamChat({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          messages: options.messages,
          signal: options.signal,
          firstTokenTimeoutMs: options.firstTokenTimeoutMs,
          fetchFn: this.fetchFn,
          onDelta: (delta) => {
            emitted = true;
            options.onDelta(delta);
          },
        });
        this.health.markSuccess(provider.id);
        return {
          provider: provider.id,
          model: provider.model,
          text: result.text,
          firstTokenMs: result.firstTokenMs,
          latencyMs: Date.now() - beganAt,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          attempts,
        };
      } catch (error) {
        const providerError =
          error instanceof ProviderError ? error : new ProviderError(String(error), { kind: "network" });
        if (providerError.kind === "aborted" || options.signal?.aborted) throw providerError;
        if (emitted) throw new MidStreamError(provider.id, providerError);
        const cooldownMs = this.cooldownFor(providerError);
        this.health.markFailure(provider.id, cooldownMs, providerError.message);
        errors.push(`${provider.id}: ${providerError.message}`);
        log.info(`provider ${provider.id} failed (${providerError.message}) — cooling down ${cooldownMs}ms, trying next`);
      }
    }

    throw new RouterError("provider_failed", `all providers failed — ${errors.join(" | ")}`);
  }

  private cooldownFor(error: ProviderError): number {
    // Bad key or revoked access: back off hard, it is not a momentary blip.
    if (error.status === 401 || error.status === 403) return 5 * 60_000;
    if (error.retryAfterMs !== undefined) return Math.max(error.retryAfterMs, 5_000);
    if (error.status === 429) return 30_000;
    if (error.kind === "timeout") return 15_000;
    if (error.status !== undefined && error.status >= 500) return 30_000;
    return 20_000;
  }

  status(): ProviderStatus[] {
    return this.providers.map((provider) => {
      const snapshot = this.health.snapshot([provider.id])[0];
      return {
        id: provider.id,
        label: provider.label,
        model: provider.model,
        tiers: provider.tiers,
        available: snapshot?.available ?? true,
        cooldownRemainingMs: snapshot?.cooldownRemainingMs ?? 0,
        lastError: snapshot?.lastError,
        lastSuccessAt: snapshot?.lastSuccessAt,
      };
    });
  }
}
