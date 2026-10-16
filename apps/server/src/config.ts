import { loadProviders, type ProviderConfig } from "./models/providers";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  providers: ProviderConfig[];
  /** Abort a provider attempt that produces no first token within this window. */
  firstTokenTimeoutMs: number;
  /** Hard ceiling for a single turn, cancellation included. */
  turnTimeoutMs: number;
  /** Grace period before a client must complete the hello handshake. */
  helloTimeoutMs: number;
  /** How many outbound frames the server keeps for `resync` replay. */
  frameLogCapacity: number;
}

function int(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  return {
    host: env.AGNI_HOST?.trim() || "127.0.0.1",
    port: int(env, "AGNI_PORT", 8787),
    dbPath: env.AGNI_DB_PATH?.trim() || "data/agni.sqlite",
    providers: loadProviders(env),
    firstTokenTimeoutMs: int(env, "AGNI_FIRST_TOKEN_TIMEOUT_MS", 3000),
    turnTimeoutMs: int(env, "AGNI_TURN_TIMEOUT_MS", 30000),
    helloTimeoutMs: int(env, "AGNI_HELLO_TIMEOUT_MS", 5000),
    frameLogCapacity: int(env, "AGNI_FRAME_LOG_CAPACITY", 1000),
  };
}
