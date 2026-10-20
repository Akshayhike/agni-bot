/**
 * `GET /health` — the daemon's own snapshot: protocol version, uptime, provider
 * health, today's usage. The app reads it for the inspector and the status
 * strip, and treats a failure as "server unreachable", not a fatal error.
 */

export interface ProviderStatus {
  id: string;
  label: string;
  model: string;
  tiers: string[];
  available: boolean;
  cooldownRemainingMs: number;
  lastError?: string;
  lastSuccessAt?: number;
}

export interface DayTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface HealthReport {
  ok: boolean;
  v: number;
  serverTime: string;
  uptimeMs: number;
  seq: number;
  providers: ProviderStatus[];
  usageToday: DayTotals;
}

export class HealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthError";
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeProvider(value: unknown): ProviderStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.label !== "string") return null;
  return {
    id: raw.id,
    label: raw.label,
    model: typeof raw.model === "string" ? raw.model : "",
    tiers: stringList(raw.tiers),
    available: raw.available === true,
    cooldownRemainingMs: numberOr(raw.cooldownRemainingMs, 0),
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
    lastSuccessAt: typeof raw.lastSuccessAt === "number" ? raw.lastSuccessAt : undefined,
  };
}

function normalizeReport(value: unknown): HealthReport {
  if (typeof value !== "object" || value === null) throw new HealthError("health returned no JSON object");
  const raw = value as Record<string, unknown>;
  const usage = (typeof raw.usageToday === "object" && raw.usageToday !== null
    ? raw.usageToday
    : {}) as Record<string, unknown>;
  const providers = Array.isArray(raw.providers)
    ? raw.providers.map(normalizeProvider).filter((provider): provider is ProviderStatus => provider !== null)
    : [];
  return {
    ok: raw.ok === true,
    v: numberOr(raw.v, 0),
    serverTime: typeof raw.serverTime === "string" ? raw.serverTime : "",
    uptimeMs: numberOr(raw.uptimeMs, 0),
    seq: numberOr(raw.seq, 0),
    providers,
    usageToday: {
      turns: numberOr(usage.turns, 0),
      inputTokens: numberOr(usage.inputTokens, 0),
      outputTokens: numberOr(usage.outputTokens, 0),
    },
  };
}

export interface FetchHealthOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function fetchHealth(url: string, options: FetchHealthOptions = {}): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? 6000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HealthError(`health timed out after ${timeoutMs} ms`)), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new HealthError(`health returned HTTP ${response.status}`);
    return normalizeReport(await response.json());
  } catch (error) {
    if (error instanceof HealthError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HealthError(`health timed out after ${timeoutMs} ms`);
    }
    throw new HealthError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

export const HealthClient = { fetch: fetchHealth };
