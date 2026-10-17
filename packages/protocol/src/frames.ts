/**
 * Agni wire protocol v2 — the contract between the server and every client
 * (Mac app, Android app, CLI).
 *
 * Frames are JSON text over a single WebSocket. Client frames carry no
 * sequence number; every server frame carries a positive, monotonically
 * increasing `seq` so clients can replay missed frames via `resync`.
 *
 * v2 introduces the conversation model: the user-facing chat surface is one
 * conversation per agent; "threads" become invisible session blocks inside it
 * (context-window seams). See docs/protocol.md and the §5 blueprint change.
 *
 * The prose spec lives in docs/protocol.md. This file is the machine version:
 * if the two disagree, this file wins — then fix the doc.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 2;

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

/** One thread, as listed by `thread.list`. */
export const ThreadInfoSchema = z.object({
  id: z.string().min(1),
  agentID: z.string().min(1),
  title: z.string().optional(),
  updatedAt: z.string(),
  /** Last message, one line, for the thread list. */
  preview: z.string().optional(),
});
export type ThreadInfo = z.infer<typeof ThreadInfoSchema>;

/** One durable message, as returned by `thread.history`. */
export const MessageInfoSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  text: z.string(),
  createdAt: z.string(),
  turnID: z.string().optional(),
  /** Session block the message belongs to (conversation model, v2). */
  sessionID: z.string().optional(),
});
export type MessageInfo = z.infer<typeof MessageInfoSchema>;

/** Why a session block boundary exists. */
export const SESSION_REASONS = ["manual", "context", "background"] as const;
export const SessionReasonSchema = z.enum(SESSION_REASONS);
export type SessionReason = z.infer<typeof SessionReasonSchema>;

/** Job lifecycle states; `done` and `failed` are terminal unless recurring. */
export const JOB_STATES = ["queued", "running", "done", "failed"] as const;
export const JobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobStateSchema>;

/** Actions `job.set` accepts on one job. */
export const JOB_ACTIONS = ["pause", "resume", "run"] as const;
export const JobActionSchema = z.enum(JOB_ACTIONS);
export type JobAction = z.infer<typeof JobActionSchema>;

/** One job, as listed by `job.list` (the Routines panel reads these). */
export const JobInfoSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  state: JobStateSchema,
  runAt: z.string(),
  enabled: z.boolean(),
  attempts: z.number().int().nonnegative(),
  /** Recurrence in milliseconds; absent for one-shot work. */
  everyMs: z.number().int().positive().optional(),
  /** The prompt this job runs, trimmed for display. */
  title: z.string().optional(),
  threadID: z.string().optional(),
  lastResult: z.string().optional(),
});
export type JobInfo = z.infer<typeof JobInfoSchema>;

export const TaskStatusSchema = z.enum(["open", "done", "snoozed"]);
export const TaskInfoSchema = z.object({
  id: z.string().min(1), title: z.string(), dueAt: z.string().nullable(),
  priority: z.enum(["low", "normal", "high"]), status: TaskStatusSchema,
  snoozedUntil: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
});
export type TaskInfo = z.infer<typeof TaskInfoSchema>;

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
    /**
     * Legacy path: target session block id; "" asks the server to rotate a
     * fresh block. Conversation clients omit it and use conversationID.
     */
    threadID: z.string().optional(),
    text: z.string().min(1),
    files: z.array(z.string()).optional(),
    /**
     * v2 conversation model: send into the conversation's active session
     * block. Takes precedence over threadID.
     */
    conversationID: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("msg.cancel"), turnID: z.string().min(1) }),
  z.object({
    type: z.literal("approve.reply"),
    requestID: z.string().min(1),
    decision: DecisionSchema,
  }),
  z.object({ type: z.literal("agent.select"), agentID: z.string().min(1) }),
  /**
   * Resolve (and create when missing) the agent's one conversation — the
   * enduring chat surface with that agent. An empty conversationID plus
   * agentID means "that agent's conversation"; the answer carries the active
   * session block id.
   */
  z.object({
    type: z.literal("conversation.open"),
    /** Empty selects by agentID; non-empty must resolve. */
    conversationID: z.string().max(64),
    agentID: z.string().min(1).optional(),
  }),
  /** Close the active session block and continue in a fresh one (/new). */
  z.object({ type: z.literal("session.new"), conversationID: z.string().min(1) }),
  /** The conversation transcript across session blocks, with sessionID per message. */
  z.object({
    type: z.literal("conversation.history"),
    conversationID: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }),
  z.object({ type: z.literal("thread.open"), threadID: z.string().min(1) }),
  /**
   * Durable-state reads. Replies are addressed to the requesting connection
   * and stay out of the replay log (they are answers, not stream state).
   */
  z.object({ type: z.literal("thread.list"), limit: z.number().int().positive().max(200).optional() }),
  z.object({
    type: z.literal("thread.history"),
    threadID: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }),
  /** Read the routine list, or act on one routine (pause, resume, run now). */
  z.object({ type: z.literal("job.list"), limit: z.number().int().positive().max(200).optional() }),
  z.object({ type: z.literal("job.set"), jobID: z.string().min(1), action: JobActionSchema }),
  /** Delete a task unless it is currently running. */
  z.object({ type: z.literal("job.delete"), jobID: z.string().min(1) }),
  z.object({ type: z.literal("task.list"), status: z.enum(["open", "done", "snoozed", "all"]).optional(), limit: z.number().int().positive().max(200).optional() }),
  z.object({ type: z.literal("task.update"), taskID: z.string().min(1), action: z.enum(["done", "reopen", "snooze"]), until: z.string().datetime().optional() }),
  /** Configure a built-in API provider. The key is accepted only by the daemon. */
  z.object({
    type: z.literal("provider.add"),
    providerID: z.enum(["groq", "cerebras", "nim", "gemini", "openrouter"]),
    apiKey: z.string().min(1).max(4096),
    model: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({
    type: z.literal("provider.model.set"),
    providerID: z.enum(["groq", "cerebras", "nim", "gemini", "openrouter"]),
    model: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal("provider.models.list"),
    providerID: z.enum(["groq", "cerebras", "nim", "gemini", "openrouter"]),
  }),
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
    /** v2: the conversation this turn belongs to (present in both lanes). */
    conversationID: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn.end"),
    seq,
    turnID: z.string(),
    threadID: z.string(),
    stopReason: StopReasonSchema,
    usage: UsageSchema.optional(),
    conversationID: z.string().optional(),
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
  z.object({ type: z.literal("notify"), seq, title: z.string(), body: z.string(), sound: z.boolean().optional(), threadID: z.string().optional() }),
  z.object({ type: z.literal("agents.update"), seq, agents: z.array(AgentInfoSchema) }),
  z.object({ type: z.literal("thread.list.ok"), seq, threads: z.array(ThreadInfoSchema) }),
  z.object({
    type: z.literal("thread.history.ok"),
    seq,
    threadID: z.string().min(1),
    title: z.string().optional(),
    messages: z.array(MessageInfoSchema),
  }),
  /**
   * Answer to `conversation.open`; addressed to the requester, outside the
   * replay log. sessionID is "" while the conversation has no blocks yet.
   */
  z.object({
    type: z.literal("conversation.ok"),
    seq,
    conversationID: z.string(),
    agentID: z.string(),
    sessionID: z.string(),
  }),
  /** A session block boundary inside the conversation (replayable stream state). */
  z.object({
    type: z.literal("session.start"),
    seq,
    conversationID: z.string(),
    sessionID: z.string(),
    reason: SessionReasonSchema,
  }),
  /** Answer to `conversation.history`; addressed to the requester. */
  z.object({
    type: z.literal("conversation.history.ok"),
    seq,
    conversationID: z.string(),
    messages: z.array(MessageInfoSchema),
  }),
  z.object({ type: z.literal("job.list.ok"), seq, jobs: z.array(JobInfoSchema) }),
  z.object({ type: z.literal("task.list.ok"), seq, tasks: z.array(TaskInfoSchema) }),
  z.object({ type: z.literal("task.update.ok"), seq, task: TaskInfoSchema }),
  z.object({ type: z.literal("provider.add.ok"), seq, providers: z.array(z.object({
    id: z.string(),
    label: z.string(),
    model: z.string(),
    available: z.boolean(),
    cooldownRemainingMs: z.number(),
    lastError: z.string().optional(),
    lastSuccessAt: z.number().optional(),
  })) }),
  z.object({ type: z.literal("provider.models.ok"), seq, providerID: z.string(), models: z.array(z.string()) }),
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
