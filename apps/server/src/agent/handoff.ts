/**
 * Agent-to-agent handoff hook.
 *
 * A handoff is the moment one agent says "I can't do this well; let X do it."
 * It is a tool call inside the task lane, not a new process: the child turn
 * runs in the same thread, streams to the same client, and lands in the same
 * session block — so the user sees one nested activity strip, not a second
 * chat.
 *
 * The hook itself is a thin wrapper around the existing `runTaskTurn` runner:
 * it builds the child `TaskTurnRun`, applies the depth/chain guardrails, and
 * returns the child's final text so the parent can fold it into its answer.
 * The durable state (turns, messages, tool_calls, agent_sessions) is shared
 * with the parent turn's stores — no duplicate schemas.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { GuardrailError, enterDelegation, rootGuardrail, type GuardrailState } from "./guardrails";
import { defaultResolvedPersona, getPersona, resolvePersona, type ResolvedPersona } from "./personas";
import type { Router } from "../models/router";
import type { TaskTurnSettings, TaskTurnRun, TaskTurnResult } from "./task-loop";
import { runTaskTurn } from "./task-loop";
import { createThread } from "../stores/threads";

export interface HandoffRequest {
  /** Agent id the work is handed to. */
  toAgentID: string;
  /** Short brief for the child — what to do, what is known. */
  task: string;
  /** Optional context the parent wants the child to have. */
  context?: string;
  /** Parent turn's emit, so the child streams to the same client. */
  emit: (frame: ServerFrameBody) => void;
  /** Parent turn's abort signal; cancelling the parent cancels the child. */
  signal: AbortSignal;
}

export interface HandoffResult {
  childTurnID: string;
  agentID: string;
  text: string;
  stopReason: string;
  /** Depth the child ran at (1 = root, 2 = first delegation). */
  depth: number;
}

export interface HandoffDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  /** The parent turn's emit. */
  emit: (frame: ServerFrameBody) => void;
  /** The parent turn's abort signal. */
  signal: AbortSignal;
  /** The parent turn's thread + conversation context. */
  threadID: string;
  conversationID?: string;
  carrySummary?: string | null;
  /** The parent's guardrail state. */
  guardrail: GuardrailState;
  /** Optional persona override for the child (defaults to the target agent's persona). */
  persona?: ResolvedPersona;
}

/**
 * Run a delegated child turn. Applies the depth/chain guardrails before
 * calling the runner; a refused delegation surfaces as a typed error the
 * parent can report to the user instead of spinning.
 */
export async function handoff(deps: HandoffDeps, request: HandoffRequest): Promise<HandoffResult> {
  const persona = deps.persona ?? resolvePersona(deps.db, request.toAgentID) ?? defaultResolvedPersona(deps.db);
  const child = enterDelegation(deps.guardrail, persona.id, request.context ?? null);
  const childThread = createThread(deps.db, persona.id, request.task);
  const childThreadID = childThread.id;

  const run: TaskTurnRun = {
    threadID: childThreadID,
    text: request.task,
    persona,
    conversationID: deps.conversationID,
    carrySummary: deps.carrySummary ?? null,
    // Child work is internal; the parent receives the result through the tool
    // response and remains the only agent writing to the user-facing stream.
    emit: (frame) => {
      if (frame.type === "status.update") deps.emit(frame);
    },
    signal: deps.signal,
    guardrail: child,
    // The child carries the handoff summary as its carried summary so it
    // opens with the parent's context — the seam between agents.
    handoffSummary: child.handoffSummary,
  };

  const result = await runTaskTurn(deps.db, deps.router, deps.settings, run);
  return {
    childTurnID: result.turnID,
    agentID: persona.id,
    text: result.text,
    stopReason: result.stopReason,
    depth: child.depth,
  };
}

/** Build the ToolContext chain metadata for a turn. */
export function chainContext(state: GuardrailState) {
  return {
    depth: state.depth,
    rootAgentID: state.rootAgentID,
    currentAgentID: state.currentAgentID,
    handoffSummary: state.handoffSummary,
  };
}

export { GuardrailError, rootGuardrail, type GuardrailState };
