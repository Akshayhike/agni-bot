/**
 * HITL approval broker. Only actions that can *destroy* state pause the loop:
 * destructive shell, writes outside the scratch tree, sends from the owner's
 * mailbox, and payment-style tools. Everything reversible runs free — reading,
 * research, memory, links, tasks, renames, and handoffs.
 *
 * The default is deliberately "free": a prompt on every reversible step trains
 * the owner to click Allow without reading, which is worse than no prompt at
 * all. A new destructive tool must add a case to `requiresApproval`.
 *
 * Approvals are durable: they live in the `approvals` table and are surfaced
 * to the client as `approval.request` frames. The decision is recorded and the
 * loop resumes (or aborts) once the client answers.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import { isDestructive } from "../tools/bash";
import { isOutsideScratch } from "../tools/write-file";

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

  /**
   * True only for actions that can destroy state — the owner's rule is "ask me
   * about destructive things, and nothing else" (2026-10-19). Everything
   * reversible is free: research, memory, links, tasks, renames, handoffs, and
   * reads. Renaming in particular is a chat-driven identity change that used to
   * stop the turn for a click; it no longer does.
   */
  requiresApproval(toolName: string, args: Record<string, unknown>): boolean {
    switch (toolName) {
      case "bash":
        return isDestructive(String(args.command ?? ""));
      case "write_file":
        // Overwriting a file destroys whatever was there, so writes outside the
        // owner-declared scratch tree gate. Inside scratch they run free.
        return isOutsideScratch(String(args.path ?? ""));
      case "mail_send":
        // Agni's own mailbox is ungated (AGENTS.md amendment 2026-10-17);
        // every other account's sends stay approval-gated.
        return args.account === "owner";
      default:
        return false;
    }
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
    case "mail_send": return `send email to ${Array.isArray(args.to) ? args.to.join(", ") : args.to}: ${String(args.subject ?? "").slice(0, 80)}`;
    case "rename_agent": return args.agentId ? `rename ${args.agentId} to ${args.name}` : `rename the assistant to ${args.name}`;
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
