/**
 * Client frame dispatch. One session per WebSocket connection:
 * connect → `hello` (token) → `hello.ok` + `agents.update` → frames.
 *
 * `msg.send` returns immediately and runs the turn detached, so `msg.cancel`
 * (and other frames) are processed while a turn streams.
 */
import type { Database } from "bun:sqlite";
import {
  PROTOCOL_VERSION,
  decodeText,
  isSupportedVersion,
  parseClientFrame,
  type ClientFrame,
  type JobInfo,
  type JobState,
  type ServerFrame,
  type ServerFrameBody,
} from "@agni/protocol";
import { defaultPersona, getPersona, personaInfo } from "../agent/personas";
import { runTaskTurn } from "../agent/task-loop";
import { resolveApprovalWaiter } from "../agent/approval-broker";
import { verifyToken } from "../auth/tokens";
import type { Config } from "../config";
import { log } from "../log";
import type { Router } from "../models/router";
import { addProviderCredential, setProviderModel } from "../models/provider-settings";
import {
  getJobByPrefix,
  listFinishedJobs,
  listJobs,
  parseJobPayload,
  deleteJob,
  setJobEnabled,
  wakeJob,
  type JobRow,
} from "../stores/jobs";
import { appendMessage, createThread, createTurn, finishTurn, getThread, listThreadsWithPreview, recentMessages, titleThreadFromFirstMessage, touchThread } from "../stores/threads";
import type { TurnJobPayload } from "../jobs/turn";
import { newID, nowISO } from "../util/ids";
import { createMemory, searchMemories } from "../stores/memories";
import { canonicalURL, saveLink, searchLinks } from "../stores/links";
import { createTask, getTask, listTasks, setTaskStatus, snoozeTask } from "../stores/tasks";
import { fetchPage } from "../tools/fetch-url";
import type { FrameLog } from "./frame-log";

export interface Session {
  id: string;
  authed: boolean;
  device?: { id: string; name: string };
  agentID: string;
  openThreadID?: string;
  /** In-flight turns owned by this connection, cancellable via msg.cancel. */
  aborts: Map<string, AbortController>;
  helloTimer?: ReturnType<typeof setTimeout>;
}

export function newSession(): Session {
  return {
    id: newID("conn"),
    authed: false,
    agentID: defaultPersona().id,
    aborts: new Map(),
  };
}

export interface DispatchDeps {
  config: Config;
  db: Database;
  router: Router;
  frameLog: FrameLog;
  /** Assign a seq, record in the frame log, fan out to every authed session. */
  emit: (body: ServerFrameBody) => ServerFrame;
  /** Answer the connection that produced the current message (not replayed). */
  reply: (body: ServerFrameBody) => ServerFrame;
  /** Send one frame to the connection that produced the current message. */
  send: (frame: ServerFrame) => void;
  /** Close the connection that produced the current message. */
  close: (code: number, reason: string) => void;
}

export async function dispatch(deps: DispatchDeps, session: Session, raw: string): Promise<void> {
  const decoded = decodeText(raw);
  if (!decoded.ok) return sendError(deps, session, "bad_frame", decoded.error);
  const parsed = parseClientFrame(decoded.value);
  if (!parsed.ok) return sendError(deps, session, "bad_frame", parsed.error);

  const frame = parsed.frame;
  switch (frame.type) {
    case "hello":
      return handleHello(deps, session, frame);
    case "resync":
      return handleResync(deps, session, frame);
    case "msg.send":
      return handleMsgSend(deps, session, frame);
    case "msg.cancel":
      return handleMsgCancel(deps, session, frame);
    case "approve.reply":
      return handleApproveReply(deps, session, frame);
    case "agent.select":
      return handleAgentSelect(deps, session, frame);
    case "thread.open":
      return handleThreadOpen(deps, session, frame);
    case "thread.list":
      return handleThreadList(deps, session, frame);
    case "thread.history":
      return handleThreadHistory(deps, session, frame);
    case "job.list":
      return handleJobList(deps, session, frame);
    case "job.set":
      return handleJobSet(deps, session, frame);
    case "job.delete":
      return handleJobDelete(deps, session, frame);
    case "task.list":
      return handleTaskList(deps, session, frame);
    case "task.update":
      return handleTaskUpdate(deps, session, frame);
    case "provider.add":
      return await handleProviderAdd(deps, session, frame);
    case "provider.model.set":
      return await handleProviderModelSet(deps, session, frame);
    case "provider.models.list":
      return await handleProviderModelsList(deps, session, frame);
  }
}

// ---------------------------------------------------------------------------

function handleHello(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "hello" }>): void {
  if (session.authed) return sendError(deps, session, "bad_frame", "hello already received");
  if (!isSupportedVersion(frame.v)) {
    sendError(deps, session, "version_mismatch", `server speaks protocol v${PROTOCOL_VERSION}`);
    deps.close(4002, "version mismatch");
    return;
  }
  void verifyToken(deps.db, frame.token).then((device) => {
    if (!device) {
      sendError(deps, session, "unauthorized", "unknown or revoked token — pair a device first");
      deps.close(4003, "unauthorized");
      return;
    }
    session.authed = true;
    session.device = { id: device.id, name: device.name };
    if (session.helloTimer !== undefined) {
      clearTimeout(session.helloTimer);
      session.helloTimer = undefined;
    }
    log.info(`hello from "${device.name}" (${device.id}) as agent ${session.agentID}`);
    // lastSeq must equal the seq this very frame is about to receive; no
    // await can interleave between the read and the reply, so this is exact.
    // The handshake answer goes only to this connection and stays out of the
    // replay log — other clients never see it, and it is not stream state.
    deps.reply({
      type: "hello.ok",
      v: PROTOCOL_VERSION,
      serverTime: nowISO(),
      lastSeq: deps.frameLog.seq + 1,
    });
    deps.emit({ type: "agents.update", agents: personaInfo() });
  });
}

function handleResync(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "resync" }>): void {
  if (!requireAuth(deps, session)) return;
  const { frames, gap, oldest } = deps.frameLog.since(frame.lastSeq);
  if (gap) {
    sendError(deps, session, "resync_gap", `cannot replay from ${frame.lastSeq}; oldest replayed frame is ${oldest}`);
    return;
  }
  for (const replay of frames) deps.send(replay);
}

function handleMsgSend(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "msg.send" }>): void {
  if (!requireAuth(deps, session)) return;

  let thread;
  if (frame.threadID) {
    thread = getThread(deps.db, frame.threadID);
    if (!thread) return sendError(deps, session, "unknown_thread", `no thread ${frame.threadID}`);
  } else {
    thread = createThread(deps.db, session.agentID);
  }

  const persona = getPersona(thread.agent_id) ?? defaultPersona();
  if (isCapture(frame.text) || isStoreQuery(frame.text)) {
    void captureMessage(deps, session, thread.id, persona.id, frame.text);
    return;
  }
  const turnID = newID("trn");
  const controller = new AbortController();
  session.aborts.set(turnID, controller);
  const turnSettings = { firstTokenTimeoutMs: deps.config.firstTokenTimeoutMs, turnTimeoutMs: deps.config.turnTimeoutMs };
  const turn = runTaskTurn(deps.db, deps.router, turnSettings, { turnID, threadID: thread.id, text: frame.text, persona, emit: deps.emit, signal: controller.signal });

  void turn
    .catch((error: unknown) => {
      // The turn runner reports its own failures through frames; landing here
      // means something unexpected (e.g. the database) failed.
      log.error("turn crashed", error);
      deps.emit({ type: "error", code: "internal", message: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      session.aborts.delete(turnID);
    });
}

function isCapture(text: string): boolean {
  return /^\s*(remember\s*:|add task\s*:)/i.test(text) || /https?:\/\/\S+/i.test(text);
}

function isStoreQuery(text: string): boolean {
  return /^\s*(search memory|search memories|search links|find saved links|what do you remember|list tasks|what tasks)\s*:?/i.test(text);
}

async function captureMessage(deps: DispatchDeps, session: Session, threadID: string, agentID: string, text: string): Promise<void> {
  const turnID = newID("trn");
  try {
    createTurn(deps.db, { id: turnID, threadID, agentID });
    appendMessage(deps.db, { threadID, turnID, role: "user", text });
    titleThreadFromFirstMessage(deps.db, threadID, text);
    deps.emit({ type: "turn.start", turnID, threadID, agentID });
    let confirmation: string;
    const memory = text.match(/^\s*remember\s*:\s*([\s\S]+)$/i);
    const task = text.match(/^\s*add task\s*:\s*([\s\S]+)$/i);
    if (isStoreQuery(text)) {
      const query = text.replace(/^\s*(?:search memories?|search links|find saved links|what do you remember|list tasks|what tasks)\s*:?\s*/i, "").trim();
      if (/^(list tasks|what tasks)/i.test(text)) {
        const rows = listTasks(deps.db, { status: "open", limit: 10, includeSnoozed: true });
        confirmation = rows.length ? `Open tasks:\n${rows.map((row) => `• ${row.title}${row.due_at ? ` — due ${row.due_at.slice(0,10)}` : ""} · ${row.priority} · ${row.status}`).join("\n")}` : "You have no open tasks.";
      } else {
        const linksQuery = /^\s*(search links|find saved links)/i.test(text);
        if (linksQuery) {
          const rows = searchLinks(deps.db, query, 8);
          confirmation = rows.length ? `Saved links:\n${rows.map((row) => `• ${row.title ?? row.url} — ${row.url}${row.note ? ` · ${row.note}` : ""} [${row.id}]`).join("\n")}` : `No saved links matched${query ? ` “${query}”` : ""}.`;
        } else {
          const rows = searchMemories(deps.db, query, 8);
          confirmation = rows.length ? `Saved memories:\n${rows.map((row) => `• ${row.summary ?? row.text} [${row.id}]`).join("\n")}` : `No saved memories matched${query ? ` “${query}”` : ""}.`;
        }
      }
    } else if (memory) {
      const body = memory[1]!.trim();
      const parsed = body.match(/^(.*?)(?:\s+#tags?\s+(.+))?$/i);
      const record = createMemory(deps.db, { text: parsed?.[1]?.trim() || body, ...(parsed?.[2] ? { tags: parsed[2].split(/[ ,]+/) } : {}), ownerDeviceID: session.device?.id });
      confirmation = `Saved memory ${record.id}: ${record.text}`;
    } else if (task) {
      const parsed = parseTaskCapture(task[1]!);
      const record = createTask(deps.db, { ...parsed, ownerDeviceID: session.device?.id });
      confirmation = `Added task ${record.id}: ${record.title}${record.due_at ? ` · due ${record.due_at}` : ""} · ${record.priority} priority`;
    } else {
      const urlMatch = text.match(/https?:\/\/[^\s<>]+/i);
      if (!urlMatch) throw new Error("no supported capture found");
      const rawURL = urlMatch[0].replace(/[),.;!?]+$/, "");
      const url = canonicalURL(rawURL);
      const note = text.replace(urlMatch[0], "").trim() || null;
      let page: { title: string|null; summary: string|null } = { title: null, summary: null };
      let fetchError: string | undefined;
      try { page = await fetchPage(url); } catch (error) { fetchError = error instanceof Error ? error.message : String(error); }
      const record = saveLink(deps.db, { url, ...page, note, ownerDeviceID: session.device?.id });
      confirmation = `Saved link ${record.id}: ${record.title ?? record.url}${record.note ? ` · note: ${record.note}` : ""}${fetchError ? ` · page details unavailable (${fetchError}); URL and note were saved` : ""}`;
    }
    appendMessage(deps.db, { threadID, turnID, role: "assistant", text: confirmation });
    finishTurn(deps.db, { id: turnID, stopReason: "end" });
    touchThread(deps.db, threadID);
    deps.emit({ type: "token", turnID, threadID, delta: confirmation });
    deps.emit({ type: "turn.end", turnID, threadID, stopReason: "end" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { finishTurn(deps.db, { id: turnID, stopReason: "error" }); } catch { /* turn may not have been created */ }
    deps.emit({ type: "error", code: "capture_failed", message });
    deps.emit({ type: "turn.end", turnID, threadID, stopReason: "error" });
  }
}

function parseTaskCapture(value: string): { title: string; dueAt?: string; priority?: "low"|"normal"|"high" } {
  let title = value.trim(), dueAt: string | undefined, priority: "low"|"normal"|"high" = "normal";
  const p = title.match(/\s+priority\s*:\s*(low|normal|high)\s*$/i);
  if (p) { priority = p[1]!.toLowerCase() as typeof priority; title = title.slice(0,p.index).trim(); }
  const due = title.match(/\s+by\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s*$/i);
  if (due) {
    const date = due[1]!;
    const parsed = new Date(`${date}T${due[2] ?? "23:59"}:00`);
    const [year, month, day] = date.split("-").map(Number);
    if (!Number.isFinite(parsed.getTime()) || parsed.getFullYear() !== year || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) throw new Error("that due date is invalid; use YYYY-MM-DD");
    dueAt = parsed.toISOString();
    title = title.slice(0,due.index).trim();
  } else if (/\bby\s+\S+/i.test(title)) {
    throw new Error("the due date is ambiguous; use `by YYYY-MM-DD` so it is saved accurately");
  }
  if (!title) throw new Error("task title is required");
  return { title, ...(dueAt ? { dueAt } : {}), priority };
}

function handleTaskList(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame,{type:"task.list"}>): void {
  if (!requireAuth(deps,session)) return;
  const status = frame.status ?? "open";
  deps.reply({ type:"task.list.ok", tasks:listTasks(deps.db,{status,limit:frame.limit,includeSnoozed:status==="open"}).map(taskSnapshot) });
}

function handleTaskUpdate(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame,{type:"task.update"}>): void {
  if (!requireAuth(deps,session)) return;
  const old=getTask(deps.db,frame.taskID);
  if(!old)return sendError(deps,session,"unknown_task",`no task ${frame.taskID}`);
  try {
    const updated=frame.action==="done"?setTaskStatus(deps.db,old.id,"done"):
      frame.action==="reopen"?setTaskStatus(deps.db,old.id,"open"):
      frame.until?snoozeTask(deps.db,old.id,frame.until):null;
    if(!updated)return sendError(deps,session,"bad_task_action","snooze requires an ISO timestamp in the future");
    deps.reply({type:"task.update.ok",task:taskSnapshot(updated)});
  } catch(error) { sendError(deps,session,"bad_task_action",error instanceof Error?error.message:String(error)); }
}

function taskSnapshot(task: ReturnType<typeof listTasks>[number]) {
  return { id:task.id,title:task.title,dueAt:task.due_at,priority:task.priority,status:task.status,snoozedUntil:task.snoozed_until,createdAt:task.created_at,updatedAt:task.updated_at };
}

function handleMsgCancel(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "msg.cancel" }>): void {
  if (!requireAuth(deps, session)) return;
  const controller = session.aborts.get(frame.turnID);
  if (!controller) {
    log.debug(`cancel for unknown/complete turn ${frame.turnID}`);
    return;
  }
  controller.abort();
}

function handleApproveReply(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "approve.reply" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const result = deps.db.run(
    "UPDATE approvals SET status = 'decided', decision = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    [frame.decision, nowISO(), frame.requestID],
  );
  if (result.changes === 0) {
    sendError(deps, session, "unknown_request", `no pending approval ${frame.requestID}`);
  }
  resolveApprovalWaiter(frame.requestID, frame.decision);
}

function handleAgentSelect(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "agent.select" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const persona = getPersona(frame.agentID);
  if (!persona) return sendError(deps, session, "unknown_agent", `no agent ${frame.agentID}`);
  session.agentID = persona.id;
}

function handleThreadOpen(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "thread.open" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const thread = getThread(deps.db, frame.threadID);
  if (!thread) return sendError(deps, session, "unknown_thread", `no thread ${frame.threadID}`);
  // No frames in response: history arrives through resync replay, live
  // activity through the normal stream. This just pins the session's thread.
  session.openThreadID = thread.id;
}

function handleThreadList(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "thread.list" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const threads = listThreadsWithPreview(deps.db, frame.limit ?? 20).map((thread) => {
    return {
      id: thread.id,
      agentID: thread.agent_id,
      ...(thread.title ? { title: thread.title } : {}),
      updatedAt: thread.updated_at,
      ...(thread.preview ? { preview: thread.preview } : {}),
    };
  });
  deps.reply({ type: "thread.list.ok", threads });
}

function handleThreadHistory(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "thread.history" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const thread = getThread(deps.db, frame.threadID);
  if (!thread) return sendError(deps, session, "unknown_thread", `no thread ${frame.threadID}`);
  const messages = recentMessages(deps.db, thread.id, frame.limit ?? 50).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.created_at,
    ...(message.turn_id ? { turnID: message.turn_id } : {}),
  }));
  deps.reply({
    type: "thread.history.ok",
    threadID: thread.id,
    ...(thread.title ? { title: thread.title } : {}),
    messages,
  });
}

/**
 * The routine list the Mac app's inspector shows: everything queued or
 * running, then the last handful of finished jobs so "what did it last do"
 * has an answer. A paused routine is listed too — pausing hides nothing.
 */
function handleJobList(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "job.list" }>,
): void {
  if (!requireAuth(deps, session)) return;
  deps.reply({ type: "job.list.ok", jobs: jobSnapshot(deps.db, frame.limit ?? 50) });
}

function handleJobSet(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "job.set" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const job = getJobByPrefix(deps.db, frame.jobID);
  if (!job) return sendError(deps, session, "unknown_job", `no job ${frame.jobID}`);

  switch (frame.action) {
    case "pause":
      setJobEnabled(deps.db, job.id, false);
      break;
    case "resume":
      setJobEnabled(deps.db, job.id, true);
      break;
    case "run":
      // "Run now" resumes a paused job: a claim would skip it otherwise.
      wakeJob(deps.db, job.id);
      break;
  }
  // The write answers with the fresh list, so toggles never drift from truth.
  deps.reply({ type: "job.list.ok", jobs: jobSnapshot(deps.db, 50) });
}

function handleJobDelete(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "job.delete" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const job = getJobByPrefix(deps.db, frame.jobID);
  if (!job) return sendError(deps, session, "unknown_job", `no job ${frame.jobID}`);
  if (!deleteJob(deps.db, job.id)) {
    return sendError(deps, session, "job_running", `task ${job.id} is running and cannot be deleted yet`);
  }
  deps.reply({ type: "job.list.ok", jobs: jobSnapshot(deps.db, 50) });
}

async function handleProviderAdd(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "provider.add" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  const result = await addProviderCredential(deps.router, frame.providerID, frame.apiKey, frame.model);
  if (!result.ok) {
    sendError(deps, session, result.code, result.message);
    return;
  }
  deps.reply({ type: "provider.add.ok", providers: result.providers });
}

async function handleProviderModelSet(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "provider.model.set" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  const result = await setProviderModel(deps.router, frame.providerID, frame.model);
  if (!result.ok) {
    sendError(deps, session, result.code, result.message);
    return;
  }
  deps.reply({ type: "provider.add.ok", providers: result.providers });
}

async function handleProviderModelsList(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "provider.models.list" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  try {
    const models = await deps.router.listModels(frame.providerID);
    deps.reply({ type: "provider.models.ok", providerID: frame.providerID, models });
  } catch (error) {
    sendError(deps, session, "provider_models", error instanceof Error ? error.message : "Could not load provider models.");
  }
}

function jobSnapshot(db: Database, limit: number): JobInfo[] {
  const seen = new Set<string>();
  const jobs: JobInfo[] = [];
  for (const row of [...listJobs(db, { limit }), ...listFinishedJobs(db, 10)]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    jobs.push(jobInfo(row));
  }
  return jobs;
}

function jobInfo(row: JobRow): JobInfo {
  const payload = turnPayload(row);
  return {
    id: row.id,
    kind: row.kind,
    // Rows only ever hold the four schema states; the cast is the narrowing.
    state: row.state as JobState,
    runAt: row.run_at,
    enabled: row.enabled === 1,
    attempts: row.attempts,
    ...(payload.everyMs ? { everyMs: payload.everyMs } : {}),
    ...(payload.text ? { title: clip(payload.text, 120) } : {}),
    ...(payload.threadID ? { threadID: payload.threadID } : {}),
    ...(row.result ? { lastResult: row.result } : {}),
  };
}

/** A non-turn job (or a damaged payload) simply has nothing to say. */
function turnPayload(row: JobRow): Partial<TurnJobPayload> {
  if (row.kind !== "turn") return {};
  try {
    return parseJobPayload<Partial<TurnJobPayload>>(row);
  } catch {
    return {};
  }
}

function clip(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

// ---------------------------------------------------------------------------

function requireAuth(deps: DispatchDeps, session: Session): boolean {
  if (session.authed) return true;
  sendError(deps, session, "unauthorized", "send hello with a device token first");
  return false;
}

function sendError(deps: DispatchDeps, _session: Session, code: string, message: string): void {
  deps.emit({ type: "error", code, message });
  log.debug(`error frame → ${code}: ${message}`);
}
