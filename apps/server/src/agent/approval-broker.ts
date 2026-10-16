/**
 * HITL approval broker. Destructive actions (rm -rf, git push, email sends,
 * financial transactions) pause the loop until the user clicks Allow/Deny.
 *
 * Approvals are durable: they live in the `approvals` table and are surfaced
 * to the client as `approval.request` frames. The decision is recorded and the
 * loop resumes (or aborts) once the client answers.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export type Decision = "once" | "always" | "reject";

const decisionWaiters = new Map<string, (decision: Decision) => void>();

/** Waiters are process-local; the approval row remains the durable authority. */
export function resolveApprovalWaiter(requestID: string, decision: Decision): void {
  decisionWaiters.get(requestID)?.(decision);
}

export function waitForApprovalDecision(db: Database, requestID: string, signal: AbortSignal): Promise<Decision | null> {
  const row = db.query("SELECT status, decision FROM approvals WHERE id = ?").get(requestID) as { status: string; decision: Decision | null } | null;
  if (!row) return Promise.resolve(null);
  if (row.status === "decided" && row.decision) return Promise.resolve(row.decision);
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (decision: Decision | null): void => {
      decisionWaiters.delete(requestID);
      signal.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = (): void => finish(null);
    decisionWaiters.set(requestID, (decision) => finish(decision));
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the update-before-registration race by reading the durable row again.
    const latest = db.query("SELECT status, decision FROM approvals WHERE id = ?").get(requestID) as typeof row;
    if (latest?.status === "decided" && latest.decision) finish(latest.decision);
  });
}

export interface ApprovalRequest {
  id: string;
  threadID: string;
  turnID: string;
  toolName: string;
  callID: string;
  action: string;
  preview: string;
  status: "pending" | "decided";
  decision: Decision | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ApprovalBrokerDeps {
  db: Database;
  emit: (frame: { type: "approval.request"; requestID: string; action: string; preview: string; buttons: Decision[] }) => void;
  /** Wait for a decision on a pending approval. */
  waitForDecision: (requestID: string, signal: AbortSignal) => Promise<Decision | null>;
}

export class ApprovalBroker {
  constructor(private readonly deps: ApprovalBrokerDeps) {}

  /** Returns the decision (or null if the caller aborted). */
  async request(
    threadID: string,
    turnID: string,
    toolName: string,
    callID: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Decision | null> {
    const action = describeAction(toolName, args);
    const preview = previewAction(toolName, args);
    const requestID = newID("apr");

    this.deps.db.run(
      `INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, call_id, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      [requestID, threadID, turnID, action, preview, callID, toolName, nowISO()],
    );

    this.deps.emit({ type: "approval.request", requestID, action, preview, buttons: ["once", "always", "reject"] });

    return this.deps.waitForDecision(requestID, signal);
  }

  /** Check whether an action is destructive and therefore requires approval. */
  requiresApproval(toolName: string, args: Record<string, unknown>): boolean {
    if (["write_file", "task_create", "task_update", "memory_write", "link_save"].includes(toolName)) return false;
    // Email sends, payments, and other side-effecting tools gate here by default.
    return toolName !== "read_file" && toolName !== "grep" && toolName !== "glob" &&
      toolName !== "memory_search" && toolName !== "links_search" && toolName !== "tasks_list" &&
      toolName !== "web_search" && toolName !== "web_fetch";
  }
}

function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": return `run shell: ${String(args.command ?? "").slice(0, 120)}`;
    case "write_file": return `write file: ${args.path ?? "?"}`;
    case "read_file": return `read file: ${args.path ?? "?"}`;
    case "memory_write": return `save memory: ${String(args.text ?? "").slice(0, 80)}`;
    case "link_save": return `save link: ${args.url ?? "?"}`;
    case "task_create": return `add task: ${args.title ?? "?"}`;
    case "task_update": return `update task ${args.id ?? "?"}`;
    default: return `${toolName}(${JSON.stringify(args).slice(0, 120)})`;
  }
}

function previewAction(toolName: string, args: Record<string, unknown>): string {
  const command = String(args.command ?? "");
  if (toolName === "bash") {
    return command.length > 200 ? `${command.slice(0, 200)}…` : command;
  }
  return describeAction(toolName, args);
}
