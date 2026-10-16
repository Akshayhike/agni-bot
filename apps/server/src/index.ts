#!/usr/bin/env bun
/**
 * Agni server entry point.
 *
 *   bun run serve            start the server (Bun auto-loads .env)
 *   bun run migrate          apply pending migrations
 *   bun run pair --name X    mint a device token (shown once)
 *   bun run devices          list paired devices
 *   bun run revoke <id>      revoke a device
 */
import { hostname } from "node:os";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { listDevices, mintToken, revokeDevice } from "./auth/tokens";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { log } from "./log";
import { HealthTracker } from "./models/health";
import { Router } from "./models/router";
import { startServer } from "./ws/server";

const [command = "serve", ...args] = Bun.argv.slice(2);

if (command === "serve") await serve();
else if (command === "pair") await pair(args);
else if (command === "migrate") migrate();
else if (command === "devices") devices();
else if (command === "revoke") revoke(args);
else usage();

async function serve(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const router = new Router(config.providers, new HealthTracker());
  const running = startServer(config, db, router);

  log.info(`agni server v${PROTOCOL_VERSION} listening on ${running.url}`);
  log.info(`db: ${config.dbPath}`);
  if (config.providers.length === 0) {
    log.warn("no providers configured — set GROQ_API_KEY / CEREBRAS_API_KEY / NVIDIA_API_KEY in .env (see .env.example)");
  } else {
    for (const provider of router.status()) {
      log.info(`provider ${provider.id.padEnd(11)} ${provider.model} [${provider.tiers.join(",")}]`);
    }
  }

  process.on("SIGINT", () => {
    log.info("shutting down");
    running.stop();
    process.exit(0);
  });
}

async function pair(args: string[]): Promise<void> {
  const name = flag(args, "--name") ?? args.find((arg) => !arg.startsWith("--")) ?? hostname();
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const { device, token } = await mintToken(db, name);
  console.log(`device: ${device.name} (${device.id})`);
  console.log(`token:  ${token}`);
  console.log("");
  console.log("Shown once — the server stores only a hash. Point clients at:");
  console.log(`  AGNI_URL=${config.host === "127.0.0.1" ? `ws://127.0.0.1:${config.port}/ws` : `ws://${config.host}:${config.port}/ws`}`);
  console.log(`  AGNI_TOKEN=${token}`);
  db.close();
}

function migrate(): void {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  console.log(`migrations up to date (${config.dbPath})`);
  db.close();
}

function devices(): void {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const rows = listDevices(db);
  if (rows.length === 0) console.log("no devices paired — run `bun run pair`");
  for (const device of rows) {
    const status = device.revoked_at ? "revoked" : "active";
    const seen = device.last_seen_at ? `last seen ${device.last_seen_at}` : "never connected";
    console.log(`${status.padEnd(8)} ${device.id}  "${device.name}"  (${seen})`);
  }
  db.close();
}

function revoke(args: string[]): void {
  const target = args[0];
  if (!target) {
    console.error("usage: bun run revoke <device-id-or-prefix>");
    process.exit(1);
  }
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const device = revokeDevice(db, target);
  if (!device) {
    console.error(`no device matching "${target}"`);
    db.close();
    process.exit(1);
  }
  console.log(`revoked ${device.id} ("${device.name}")`);
  db.close();
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

function usage(): void {
  console.log(`agni server

  serve            start the HTTP/WebSocket server (default)
  migrate          apply pending database migrations
  pair [--name X]  mint a device token for a client (shown once)
  devices          list paired devices
  revoke <id>      revoke a device token`);
}
