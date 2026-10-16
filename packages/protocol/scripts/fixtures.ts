#!/usr/bin/env bun
/**
 * Protocol fixtures — one example of every frame, written to
 * `packages/protocol/fixtures/frames.json`.
 *
 * The Swift app mirrors these shapes by hand (no codegen between TS and Swift),
 * so this file is the shared contract test: `swift test` in apps/mac decodes
 * every fixture here, and fails if the two languages drift. Regenerate with
 * `bun run fixtures` after any frame change.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PROTOCOL_VERSION,
  ClientFrameSchema,
  ServerFrameSchema,
  parseClientFrame,
  parseServerFrame,
  type ClientFrame,
  type ServerFrame,
} from "../src/index.ts";

const CLIENT_FRAMES: ClientFrame[] = [
  { type: "hello", v: PROTOCOL_VERSION, token: "agni_ZmFrZS10b2tlbg", device: "Nachiketh's Mac" },
  { type: "resync", lastSeq: 41 },
  { type: "msg.send", threadID: "thr_01hq", text: "remind me at 5 to call the plumber" },
  { type: "msg.send", threadID: "", text: "new thread, no id yet" },
  { type: "msg.cancel", turnID: "trn_01hq" },
  { type: "approve.reply", requestID: "apr_01hq", decision: "once" },
  { type: "agent.select", agentID: "agni" },
  { type: "thread.open", threadID: "thr_01hq" },
  { type: "thread.list", limit: 20 },
  { type: "thread.history", threadID: "thr_01hq", limit: 50 },
  { type: "job.list", limit: 50 },
  { type: "job.set", jobID: "job_01hq", action: "pause" },
  { type: "task.list", status: "open", limit: 50 },
  { type: "task.update", taskID: "tsk_01hq", action: "snooze", until: "2026-10-17T01:00:00.000Z" },
  { type: "job.delete", jobID: "job_01hr" },
  { type: "provider.add", providerID: "groq", apiKey: "fixture-key", model: "llama-3.1-8b-instant" },
  { type: "provider.model.set", providerID: "groq", model: "llama-3.1-8b-instant" },
  { type: "provider.models.list", providerID: "groq" },
];

const SERVER_FRAMES: ServerFrame[] = [
  { type: "hello.ok", seq: 42, v: PROTOCOL_VERSION, serverTime: "2026-10-16T12:00:00.000Z", lastSeq: 42 },
  { type: "token", seq: 43, turnID: "trn_01hq", threadID: "thr_01hq", delta: "Call " },
  { type: "turn.start", seq: 44, turnID: "trn_01hq", threadID: "thr_01hq", agentID: "agni" },
  {
    type: "turn.end",
    seq: 45,
    turnID: "trn_01hq",
    threadID: "thr_01hq",
    stopReason: "end",
    usage: { provider: "groq", model: "llama-3.1-8b-instant", inputTokens: 128, outputTokens: 24, latencyMs: 412 },
  },
  { type: "turn.end", seq: 46, turnID: "trn_01hr", threadID: "thr_01hq", stopReason: "cancelled" },
  { type: "tool.start", seq: 47, callID: "call_01hq", name: "memory.search", preview: "passport expiry" },
  { type: "tool.update", seq: 48, callID: "call_01hq", preview: "3 matches" },
  { type: "tool.end", seq: 49, callID: "call_01hq", ok: true, preview: "3 matches" },
  {
    type: "approval.request",
    seq: 50,
    requestID: "apr_01hq",
    action: "shell: git push origin main",
    preview: "git push origin main\n→ To github.com:theynr/agni.git",
    buttons: ["once", "always", "reject"],
  },
  {
    type: "form.request",
    seq: 51,
    requestID: "frm_01hq",
    question: "Which inbox should the brief watch while you're away?",
    options: ["agent", "personal", "both"],
  },
  { type: "notify", seq: 52, title: "Agni · standup in 10", body: "You asked to be nudged before the 09:30 standup.", sound: true, threadID: "thr_01hq" },
  {
    type: "agents.update",
    seq: 53,
    agents: [
      { id: "agni", name: "Agni", color: "#f0b95a", tools: [] },
      { id: "scout", name: "Scout", color: "#7cc4ff", model: "gemini-2.0-flash", tools: ["links.search"] },
    ],
  },
  {
    type: "thread.list.ok",
    seq: 54,
    threads: [
      { id: "thr_01hq", agentID: "agni", title: "remind me at 5 to call the plumber", updatedAt: "2026-10-16T12:00:00.000Z", preview: "Set for 17:00." },
      { id: "thr_01hp", agentID: "agni", updatedAt: "2026-10-15T09:12:00.000Z" },
    ],
  },
  {
    type: "thread.history.ok",
    seq: 55,
    threadID: "thr_01hq",
    title: "remind me at 5 to call the plumber",
    messages: [
      { id: "msg_01hq", role: "user", text: "remind me at 5 to call the plumber", createdAt: "2026-10-16T11:59:58.000Z" },
      {
        id: "msg_01hr",
        role: "assistant",
        text: "Set for 17:00.",
        createdAt: "2026-10-16T12:00:00.000Z",
        turnID: "trn_01hq",
      },
    ],
  },
  {
    type: "job.list.ok",
    seq: 56,
    jobs: [
      {
        id: "job_01hq",
        kind: "turn",
        state: "queued",
        runAt: "2026-10-17T07:55:00.000Z",
        enabled: true,
        attempts: 4,
        everyMs: 86_400_000,
        title: "precompute the morning brief",
        threadID: "thr_01hr",
        lastResult: "thread thr_01hr: Inbox is quiet; two links worth a look. (recurring)",
      },
      {
        id: "job_01hr",
        kind: "turn",
        state: "queued",
        runAt: "2026-10-16T17:00:00.000Z",
        enabled: false,
        attempts: 0,
        title: "remind me to call the plumber",
      },
    ],
  },
  { type: "task.list.ok", seq: 59, tasks: [{ id: "tsk_01hq", title: "Renew insurance", dueAt: "2026-10-17T01:00:00.000Z", priority: "high", status: "open", snoozedUntil: null, createdAt: "2026-10-16T12:00:00.000Z", updatedAt: "2026-10-16T12:00:00.000Z" }] },
  { type: "task.update.ok", seq: 60, task: { id: "tsk_01hq", title: "Renew insurance", dueAt: "2026-10-17T01:00:00.000Z", priority: "high", status: "snoozed", snoozedUntil: "2026-10-17T01:00:00.000Z", createdAt: "2026-10-16T12:00:00.000Z", updatedAt: "2026-10-16T12:01:00.000Z" } },
  { type: "provider.add.ok", seq: 61, providers: [{ id: "groq", label: "Groq", model: "llama-3.1-8b-instant", tiers: ["instant"], available: true, cooldownRemainingMs: 0 }] },
  { type: "provider.models.ok", seq: 62, providerID: "groq", models: ["llama-3.1-8b-instant"] },
  { type: "presence", seq: 57, state: "offline" },
  { type: "error", seq: 58, code: "no_provider", message: "no provider in tier instant", retryAfter: 2 },
];

/** Every frame must survive its own schema before it is a fixture. */
const problems: string[] = [];
for (const frame of CLIENT_FRAMES) {
  const parsed = parseClientFrame(frame);
  if (!parsed.ok) problems.push(`client ${frame.type}: ${parsed.error}`);
}
for (const frame of SERVER_FRAMES) {
  const parsed = parseServerFrame(frame);
  if (!parsed.ok) problems.push(`server ${frame.type}: ${parsed.error}`);
}

// A fixture set that misses a frame type is a fixture set that stops catching
// drift — every variant of the union has to be represented, plus its schema.
const clientTypes = new Set(CLIENT_FRAMES.map((frame) => frame.type));
const serverTypes = new Set(SERVER_FRAMES.map((frame) => frame.type));
for (const option of ClientFrameSchema.options) {
  const literal = option.shape.type.value as ClientFrame["type"];
  if (!clientTypes.has(literal)) problems.push(`no client fixture for "${literal}"`);
}
for (const option of ServerFrameSchema.options) {
  const literal = option.shape.type.value as ServerFrame["type"];
  if (!serverTypes.has(literal)) problems.push(`no server fixture for "${literal}"`);
}

if (problems.length > 0) {
  console.error("fixture set is incomplete or malformed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const out = join(import.meta.dir, "..", "fixtures", "frames.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, client: CLIENT_FRAMES, server: SERVER_FRAMES }, null, 2)}\n`,
);
console.log(`wrote ${CLIENT_FRAMES.length} client + ${SERVER_FRAMES.length} server fixtures → ${out}`);
