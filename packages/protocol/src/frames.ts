/**
 * Agni wire protocol v1 — the contract between the server and every client
 * (Mac app, Android app, CLI).
 *
 * Frames are JSON text over a single WebSocket. Client frames carry no
 * sequence number; every server frame carries a positive, monotonically
 * increasing `seq` so clients can replay missed frames via `resync`.
 *
 * The prose spec lives in docs/protocol.md. This file is the machine version:
 * if the two disagree, this file wins — then fix the doc.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Server-assigned monotonic sequence number. */
const seq = z.number().int().positive();

export const STOP_REASONS = ["end", "cancelled", "error", "timeout", "budget"] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Approval button / answer tokens. */
export const DECISIONS = ["once", "always", "reject"] as const;
export const DecisionSchema = z.enum(DECISIONS);
export type Decision = z.infer<typeof DecisionSchema>;

export const UsageSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AgentInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

// ---------------------------------------------------------------------------
// client → server
// ---------------------------------------------------------------------------

export const ClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    v: z.number().int(),
    token: z.string().min(1),
    device: z.string().min(1),
  }),
  z.object({ type: z.literal("resync"), lastSeq: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("msg.send"),
    /** Empty string asks the server to create a new thread. */
    threadID: z.string(),
    text: z.string().min(1),
    files: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("msg.cancel"), turnID: z.string().min(1) }),
  z.object({
    type: z.literal("approve.reply"),
    requestID: z.string().min(1),
    decision: DecisionSchema,
  }),
  z.object({ type: z.literal("agent.select"), agentID: z.string().min(1) }),
  z.object({ type: z.literal("thread.open"), threadID: z.string().min(1) }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ClientFrameType = ClientFrame["type"];

// ---------------------------------------------------------------------------
// server → client
// ---------------------------------------------------------------------------

export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello.ok"),
    seq,
    /** Server protocol version; always PROTOCOL_VERSION. */
    v: z.number().int(),
    serverTime: z.string(),
    /** Highest seq the server has assigned so far. */
    lastSeq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("token"), seq, turnID: z.string(), threadID: z.string(), delta: z.string() }),
  z.object({
    type: z.literal("turn.start"),
    seq,
    turnID: z.string(),
    threadID: z.string(),
    agentID: z.string(),
  }),
  z.object({
    type: z.literal("turn.end"),
    seq,
    turnID: z.string(),
    threadID: z.string(),
    stopReason: StopReasonSchema,
    usage: UsageSchema.optional(),
  }),
  z.object({ type: z.literal("tool.start"), seq, callID: z.string(), name: z.string(), preview: z.string().optional() }),
  z.object({ type: z.literal("tool.update"), seq, callID: z.string(), preview: z.string().optional() }),
  z.object({ type: z.literal("tool.end"), seq, callID: z.string(), ok: z.boolean(), preview: z.string().optional() }),
  z.object({
    type: z.literal("approval.request"),
    seq,
    requestID: z.string(),
    action: z.string(),
    preview: z.string(),
    buttons: z.array(DecisionSchema).min(1),
  }),
  z.object({
    type: z.literal("form.request"),
    seq,
    requestID: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("notify"), seq, title: z.string(), body: z.string(), sound: z.boolean().optional() }),
  z.object({ type: z.literal("agents.update"), seq, agents: z.array(AgentInfoSchema) }),
  z.object({ type: z.literal("presence"), seq, state: z.enum(["online", "offline"]) }),
  z.object({ type: z.literal("error"), seq, code: z.string(), message: z.string(), retryAfter: z.number().optional() }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type ServerFrameType = ServerFrame["type"];

/** A server frame before the frame log assigns its seq. */
export type ServerFrameBody = ServerFrame extends infer T
  ? T extends { seq: number }
    ? Omit<T, "seq">
    : never
  : never;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; frame: T } | { ok: false; error: string };

type ZodLikeIssue = { path: readonly PropertyKey[]; message: string };

function issuesToText(error: { issues: readonly ZodLikeIssue[] }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length ? issue.path.map((segment) => String(segment)).join(".") : "frame";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseClientFrame(input: unknown): ParseResult<ClientFrame> {
  const result = ClientFrameSchema.safeParse(input);
  return result.success ? { ok: true, frame: result.data } : { ok: false, error: issuesToText(result.error) };
}

export function parseServerFrame(input: unknown): ParseResult<ServerFrame> {
  const result = ServerFrameSchema.safeParse(input);
  return result.success ? { ok: true, frame: result.data } : { ok: false, error: issuesToText(result.error) };
}

/** Parse a raw WebSocket text message into an unknown value. */
export function decodeText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

export function encodeFrame(frame: ClientFrame | ServerFrame | ServerFrameBody): string {
  return JSON.stringify(frame);
}

export function isSupportedVersion(v: number): boolean {
  return v === PROTOCOL_VERSION;
}
