/** Persist provider credentials on the daemon host and refresh its live router. */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadProviders, providerCredentialTarget, providerModelTarget } from "./providers";
import type { Router } from "./router";

export type AddProviderResult =
  | { ok: true; providers: ReturnType<Router["status"]> }
  | { ok: false; code: "unknown_provider" | "invalid_key" | "provider_exists" | "provider_storage"; message: string };

/**
 * The API key arrives only over the authenticated socket. It is written to the
 * daemon's .env with mode 0600, never returned to the client, and applied to
 * the live router without restarting the process.
 */
export async function addProviderCredential(router: Router, providerID: string, rawKey: string, model?: string): Promise<AddProviderResult> {
  const target = providerCredentialTarget(providerID);
  if (!target) {
    return { ok: false, code: "unknown_provider", message: "Choose a supported API provider." };
  }
  const apiKey = rawKey.trim();
  if (!apiKey || apiKey.length > 4096 || /[\u0000\r\n]/.test(apiKey)) {
    return { ok: false, code: "invalid_key", message: "Enter a valid API key." };
  }
  if (router.status().some((provider) => provider.id === target.id)) {
    return { ok: false, code: "provider_exists", message: `${target.label} is already configured.` };
  }

  const envPath = resolve(process.cwd(), ".env");
  const temporaryPath = `${envPath}.${randomUUID()}.tmp`;
  try {
    let contents = "";
    try {
      contents = await readFile(envPath, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    const nextContents = updateEnv(contents, { [target.envKey]: apiKey });

    await writeFile(temporaryPath, nextContents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, envPath);
    await chmod(envPath, 0o600);

    // Bun.env is the environment map used by the rest of this process.
    Bun.env[target.envKey] = apiKey;
    if (model?.trim()) await saveProviderModel(providerID, validateModel(model));
    router.replaceProviders(loadProviders(Bun.env));
    return { ok: true, providers: router.status() };
  } catch {
    // Do not include the key or filesystem content in the response/log path.
    return { ok: false, code: "provider_storage", message: "Could not save the provider key on the daemon." };
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}


export async function setProviderModel(router: Router, providerID: string, rawModel: string): Promise<AddProviderResult> {
  const target = providerModelTarget(providerID);
  if (!target) return { ok: false, code: "unknown_provider", message: "Choose a supported API provider." };
  if (!router.status().some((provider) => provider.id === providerID)) {
    return { ok: false, code: "provider_exists", message: "Add this provider before changing its model." };
  }
  let model: string;
  try { model = validateModel(rawModel); } catch (error) {
    return { ok: false, code: "invalid_key", message: error instanceof Error ? error.message : "Enter a valid model ID." };
  }
  try {
    await saveProviderModel(providerID, model);
    router.replaceProviders(loadProviders(Bun.env));
    return { ok: true, providers: router.status() };
  } catch {
    return { ok: false, code: "provider_storage", message: "Could not save the model setting on the daemon." };
  }
}

async function saveProviderModel(providerID: string, model: string): Promise<void> {
  const path = resolve(Bun.env.AGNI_PROVIDER_CONFIG_PATH?.trim() || "data/providers.json");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  let models: Record<string, string> = {};
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; models?: unknown };
    if (value.version === 1 && value.models && typeof value.models === "object" && !Array.isArray(value.models)) {
      models = Object.fromEntries(Object.entries(value.models).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("The provider config file is invalid or unreadable.");
    }
  }
  models[providerID] = model;
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function validateModel(raw: string): string {
  const model = raw.trim();
  if (!model || model.length > 200 || /[\u0000\r\n]/.test(model)) throw new Error("Enter a model ID up to 200 characters.");
  return model;
}

function updateEnv(contents: string, values: Record<string, string>): string {
  let next = contents;
  for (const [key, value] of Object.entries(values)) {
    const assignment = `${key}=${JSON.stringify(value)}`;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "m");
    next = pattern.test(next) ? next.replace(pattern, assignment) : `${next}${next.length > 0 && !next.endsWith("\n") ? "\n" : ""}${assignment}\n`;
  }
  return next;
}
