/**
 * Provider catalog — every source is OpenAI-compatible `chat/completions`,
 * enabled by the presence of its API key (except LM Studio, which is local).
 *
 * Free-first per Blueprint v3 §8: instant lane prefers the very fast free
 * tiers (Groq, Cerebras), task lane prefers NIM, deep lane Gemini/OpenRouter.
 * Ordering here is only the default — the router reorders around health.
 */

export type Tier = "instant" | "task" | "deep";

export const TIERS: Tier[] = ["instant", "task", "deep"];

export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  tiers: Tier[];
}

interface ProviderSpec {
  id: string;
  label: string;
  baseUrl: string;
  /** Environment variable that carries the API key. LM Studio has none. */
  envKey: string | null;
  /** Optional env override for the endpoint (proxies, self-hosted, tests). */
  envBaseUrl?: string;
  envModel: string;
  model: string;
  tiers: Tier[];
}

const SPECS: ProviderSpec[] = [
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    envBaseUrl: "GROQ_BASE_URL",
    envModel: "GROQ_MODEL",
    model: "llama-3.1-8b-instant",
    tiers: ["instant"],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    envBaseUrl: "CEREBRAS_BASE_URL",
    envModel: "CEREBRAS_MODEL",
    model: "llama3.1-8b",
    tiers: ["instant"],
  },
  {
    id: "nim",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    envBaseUrl: "NVIDIA_BASE_URL",
    envModel: "NIM_MODEL",
    model: "meta/llama-3.3-70b-instruct",
    tiers: ["instant", "task", "deep"],
  },
  {
    id: "gemini",
    label: "Gemini (free tier)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    envBaseUrl: "GEMINI_BASE_URL",
    envModel: "GEMINI_MODEL",
    model: "gemini-2.0-flash",
    tiers: ["task", "deep"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (:free)",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    envBaseUrl: "OPENROUTER_BASE_URL",
    envModel: "OPENROUTER_MODEL",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    tiers: ["deep"],
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://127.0.0.1:1234/v1",
    envKey: null,
    envBaseUrl: "LMSTUDIO_BASE_URL",
    envModel: "LMSTUDIO_MODEL",
    model: "",
    tiers: ["instant", "task", "deep"],
  },
];

/** Failover preference per lane. Unknown/unlisted providers fall to the end. */
export const TIER_ORDER: Record<Tier, string[]> = {
  instant: ["groq", "cerebras", "nim", "lmstudio"],
  task: ["nim", "gemini", "lmstudio", "groq"],
  deep: ["gemini", "openrouter", "nim", "lmstudio"],
};

export function loadProviders(env: Record<string, string | undefined>): ProviderConfig[] {
  const providers: ProviderConfig[] = [];
  for (const spec of SPECS) {
    if (spec.envKey === null) {
      // Local provider: enabled by explicitly naming a model to serve.
      const model = env[spec.envModel]?.trim();
      if (!model) continue;
      providers.push({
        id: spec.id,
        label: spec.label,
        baseUrl: (spec.envBaseUrl && env[spec.envBaseUrl]?.trim()) || spec.baseUrl,
        apiKey: "lm-studio", // LM Studio ignores auth but the header must exist.
        model,
        tiers: spec.tiers,
      });
      continue;
    }
    const apiKey = env[spec.envKey]?.trim();
    if (!apiKey) continue;
    providers.push({
      id: spec.id,
      label: spec.label,
      baseUrl: (spec.envBaseUrl && env[spec.envBaseUrl]?.trim()) || spec.baseUrl,
      apiKey,
      model: env[spec.envModel]?.trim() || spec.model,
      tiers: spec.tiers,
    });
  }
  return providers;
}
