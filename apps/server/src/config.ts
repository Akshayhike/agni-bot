import { loadProviders, type ProviderConfig } from "./models/providers";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** PID file written by `daemon start` (empty in tests). */
  pidPath: string;
  /** Log file the detached daemon appends to. */
  logPath: string;
  providers: ProviderConfig[];
  /** Abort a provider attempt that produces no first token within this window. */
  firstTokenTimeoutMs: number;
  /** Hard ceiling for a single turn, cancellation included. */
  turnTimeoutMs: number;
  /** Grace period before a client must complete the hello handshake. */
  helloTimeoutMs: number;
  /** How many outbound frames the server keeps for `resync` replay. */
  frameLogCapacity: number;
  /** How often the job runner looks for due work. */
  jobPollMs: number;
  /** Maximum simultaneous model streams across chat and background turns. */
  maxConcurrentTurns: number;
  /** Google OAuth client for plugin connections (both values required). */
  googleOAuthClientID: string;
  googleOAuthClientSecret: string;
  /** Gmail app password auth (simpler than OAuth, requires 2FA on the account). */
  gmailUser: string;
  gmailAppPassword: string;
  /** Optional second mailbox (the owner's) via app password. */
  gmailOwnerUser: string;
  gmailOwnerAppPassword: string;
  /** Firecrawl self-hosted instance URL (open source, unlimited). */
  firecrawlURL: string;
  /** Firecrawl cloud API key (free tier: 500 credits/mo). */
  firecrawlAPIKey: string;
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
    pidPath: env.AGNI_PID_PATH?.trim() || "data/agni.pid",
    logPath: env.AGNI_LOG_PATH?.trim() || "data/agni.log",
    providers: loadProviders(env),
    firstTokenTimeoutMs: int(env, "AGNI_FIRST_TOKEN_TIMEOUT_MS", 30000),
    turnTimeoutMs: int(env, "AGNI_TURN_TIMEOUT_MS", 120000),
    helloTimeoutMs: int(env, "AGNI_HELLO_TIMEOUT_MS", 5000),
    frameLogCapacity: int(env, "AGNI_FRAME_LOG_CAPACITY", 1000),
    jobPollMs: int(env, "AGNI_JOB_POLL_MS", 3000),
    maxConcurrentTurns: int(env, "AGNI_MAX_CONCURRENT_TURNS", 4),
    googleOAuthClientID: env.GOOGLE_OAUTH_CLIENT_ID?.trim() || "",
    googleOAuthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || "",
    gmailUser: env.GMAIL_USER?.trim() || "",
    gmailAppPassword: env.GMAIL_APP_PASSWORD?.trim() || "",
    gmailOwnerUser: env.GMAIL_OWNER_USER?.trim() || "",
    gmailOwnerAppPassword: env.GMAIL_OWNER_APP_PASSWORD?.trim() || "",
    firecrawlURL: env.AGNI_FIRECRAWL_URL?.trim() || "",
    firecrawlAPIKey: env.AGNI_FIRECRAWL_API_KEY?.trim() || "",
  };
}
