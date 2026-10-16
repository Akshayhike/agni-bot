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
  type ServerFrame,
  type ServerFrameBody,
} from "@agni/protocol";
import { defaultPersona, getPersona, personaInfo } from "../agent/personas";
import { runInstantTurn } from "../agent/loop";
import { verifyToken } from "../auth/tokens";
import type { Config } from "../config";
import { log } from "../log";
import type { Router } from "../models/router";
import { createThread, getThread } from "../stores/threads";
import { newID, nowISO } from "../util/ids";
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
    // await can interleave between the read and the emit, so this is exact.
    deps.emit({
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
  const turnID = newID("trn");
  const controller = new AbortController();
  session.aborts.set(turnID, controller);

  void runInstantTurn(
    deps.db,
    deps.router,
    { firstTokenTimeoutMs: deps.config.firstTokenTimeoutMs, turnTimeoutMs: deps.config.turnTimeoutMs },
    {
      threadID: thread.id,
      text: frame.text,
      persona,
      emit: deps.emit,
      signal: controller.signal,
    },
  )
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
