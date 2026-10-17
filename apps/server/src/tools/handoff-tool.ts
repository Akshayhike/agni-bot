/**
 * Register the `handoff` tool on a task-lane registry.
 *
 * The handoff tool is a closure over the running turn's deps so it can spawn
 * a delegated child turn in the same thread. It is registered per-turn (like
 * the mail tools) rather than in the static registry, because its handler
 * needs the live emit/signal/guardrail — it is not a pure function of `db`.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { ToolRegistry } from "./registry";
import type { TaskTurnSettings } from "../agent/task-loop";
import type { Router } from "../models/router";
import type { GuardrailState } from "../agent/guardrails";
import { handoff, type HandoffDeps, type HandoffRequest } from "../agent/handoff";
import { appendChannelMessage } from "../stores/channels";

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});
const stringProp = { type: "string", minLength: 1 };

export interface HandoffToolDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  emit: (frame: ServerFrameBody) => void;
  signal: AbortSignal;
  threadID: string;
  channelID?: string;
  currentAgentID: string;
  conversationID?: string;
  carrySummary?: string | null;
  guardrail: GuardrailState;
}

export function registerHandoffTool(registry: ToolRegistry, deps: HandoffToolDeps): void {
  if (registry.get("handoff")) return;
  registry.register({
    name: "handoff",
    description:
      "Delegate a sub-task to another agent in the same thread. Use when you cannot do something yourself — " +
      "e.g. a coding job belongs to an ACP harness. The child streams into the same thread and you get its answer back. " +
      "Do not delegate just to delegate: only when another agent is genuinely better suited.",
    kind: "static",
    schema: objectSchema({
      toAgentID: stringProp,
      task: { type: "string", minLength: 1, maxLength: 4_000 },
      context: { type: "string", maxLength: 2_000 },
    }, ["toAgentID", "task"]),
    timeoutMs: 120_000,
    handler: async (args: Record<string, unknown>) => {
      const targetAgentID = String(args.toAgentID).trim();
      if (deps.channelID) {
        const parent = deps.db.query<{ display_name: string; avatar_color: string | null }, [string]>(
          "SELECT display_name, avatar_color FROM agents WHERE id = ?",
        ).get(deps.currentAgentID);
        const notice = `${parent?.display_name ?? deps.currentAgentID} → ${targetAgentID} · synthesizing`;
        const row = appendChannelMessage(deps.db, {
          channelID: deps.channelID, fromType: "system", fromID: deps.currentAgentID,
          text: notice, uiHint: "handoff_notice",
        });
        deps.emit({
          type: "msg.new", id: row.id, channelId: deps.channelID, fromType: "system",
          fromId: deps.currentAgentID, senderName: parent?.display_name ?? deps.currentAgentID,
          senderColor: parent?.avatar_color ?? undefined, text: notice, internal: false,
          uiHint: "handoff_notice", createdAt: row.created_at,
        });
        deps.emit({
          type: "status.update", channelId: deps.channelID, agentId: targetAgentID,
          text: `Handing off to ${targetAgentID}…`, transient: true,
        });
      }
      const request: HandoffRequest = {
        toAgentID: targetAgentID,
        task: String(args.task).trim(),
        context: args.context === undefined ? undefined : String(args.context).trim(),
        emit: deps.emit,
        signal: deps.signal,
      };
      const handoffDeps: HandoffDeps = {
        db: deps.db,
        router: deps.router,
        settings: deps.settings,
        emit: deps.emit,
        signal: deps.signal,
        threadID: deps.threadID,
        conversationID: deps.conversationID,
        carrySummary: deps.carrySummary,
        guardrail: deps.guardrail,
      };
      const result = await handoff(handoffDeps, request);
      return {
        childTurnID: result.childTurnID,
        agentID: result.agentID,
        depth: result.depth,
        stopReason: result.stopReason,
        text: result.text,
      };
    },
  });
}
