#!/usr/bin/env bun
/**
 * Headless end-to-end smoke test for the client core the web app is built on.
 *
 *   AGNI_URL=ws://127.0.0.1:8788/ws AGNI_TOKEN=… bun run smoke
 *
 * It exercises the same path the browser does: health over HTTP (including the
 * CORS header), the WebSocket handshake, `conversation.open`, `msg.send`, the
 * streamed `token` frames, and the reducer that turns them into a reply.
 */
import {
  AgniConnection,
  Conversation,
  isReady,
  websocketURL,
  healthURL,
  type ServerSettings,
} from "../src/index.ts";

const rawURL = process.env.AGNI_URL ?? "ws://127.0.0.1:8787/ws";
const token = process.env.AGNI_TOKEN?.trim();
if (!token) {
  console.error("AGNI_TOKEN is required (mint one with: bun run pair --name WebSmoke)");
  process.exit(2);
}

const settings: ServerSettings = { url: rawURL, deviceName: "Web client smoke", lastSeq: 0 };
const wsURL = websocketURL(settings);
const httpURL = healthURL(settings);
if (!wsURL || !httpURL) {
  console.error(`not a usable server address: ${rawURL}`);
  process.exit(2);
}

const health = await fetch(httpURL, { headers: { accept: "application/json" } });
if (!health.ok) {
  console.error(`health failed: HTTP ${health.status} from ${httpURL}`);
  process.exit(1);
}
const cors = health.headers.get("access-control-allow-origin");
if (cors !== "*") {
  console.error(`health is missing CORS for browser pairing: access-control-allow-origin=${cors ?? "(none)"}`);
  process.exit(1);
}
const report = (await health.json()) as { ok?: boolean; v?: number; providers?: unknown[] };
console.log(`health ok (protocol v${report.v ?? "?"}, ${report.providers?.length ?? 0} provider(s), CORS ${cors})`);

const conversation = new Conversation("ea");
const connection = new AgniConnection({ settings, token });
const prompt = `smoke ${new Date().toISOString()}`;
let messageSent = false;
let expectingTurn = false;
let turnID: string | null = null;
let deltas = 0;

const reply = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => {
    connection.stop();
    reject(new Error("timed out waiting for the streamed reply"));
  }, 45_000);

  const finish = (error: Error | null, text = "") => {
    clearTimeout(timer);
    connection.stop();
    if (error) reject(error);
    else resolve(text);
  };

  connection.onEvent = (event) => {
    try {
      if (event.type === "state") {
        if (isReady(event.state) && !messageSent) {
          messageSent = true;
          void (async () => {
            await connection.send({ type: "agent.select", agentID: "ea" });
            await connection.send({ type: "conversation.open", conversationID: "", agentID: "ea" });
          })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
        }
        return;
      }
      if (event.type === "malformed") {
        finish(new Error(`unreadable frame: ${event.detail}`));
        return;
      }
      if (event.type !== "frame") return;
      const frame = event.frame;
      if ("__unknown" in frame) return;

      if (frame.type === "conversation.ok") {
        conversation.bind(frame.conversationID, frame.agentID, frame.sessionID.length > 0 ? frame.sessionID : null);
        if (expectingTurn) return;
        expectingTurn = true;
        void connection
          .send({ type: "msg.send", text: prompt, channelId: "main" })
          .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      }

      if (frame.type === "turn.start" && expectingTurn && turnID === null) turnID = frame.turnID;
      if (frame.type === "token" && turnID !== null && frame.turnID === turnID) deltas += 1;

      conversation.apply(frame);

      if (frame.type === "turn.end" && turnID !== null && frame.turnID === turnID) {
        const assistant = conversation.messages.find((message) => message.id === `asst_${frame.turnID}`);
        const text = assistant?.text ?? "";
        if (frame.stopReason !== "end") {
          finish(new Error(`turn ended with ${frame.stopReason}`));
          return;
        }
        if (!text.startsWith("mock(mock-model):")) {
          finish(new Error(`unexpected reply from the mock provider: ${JSON.stringify(text.slice(0, 160))}`));
          return;
        }
        if (!text.includes(prompt)) {
          finish(new Error("the reply did not echo the prompt that was sent"));
          return;
        }
        finish(null, text);
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  };

  connection.start();
});

console.log(`streamed ${deltas} delta(s)`);
console.log(`reply: ${reply.trim()}`);
console.log("smoke ok");
