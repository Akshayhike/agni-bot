/**
 * Register the `handoff` tool on a task-lane registry.
 *
 * The handoff tool is a closure over the running turn's deps so it can spawn
 * a delegated child turn in the same thread. It is registered per-turn (like
 * the mail tools) rather than in the static registry, because its handler
 * needs the live emit/signal/guardrail — it is not a pure function of `db`.
 *
 * Visibility is the point of this file. Delegation used to be invisible: the
 * child ran in an internal thread and only the parent's synthesis reached the
 * user. Now the flow reads as a conversation — a notice saying who was asked
 * and what for, then the specialist's own answer as a message from that agent,
 * then the parent's synthesis on top.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { ToolRegistry } from "./registry";
import type { TaskTurnSettings } from "../agent/task-loop";
import type { Router } from "../models/router";
import type { GuardrailState } from "../agent/guardrails";
import { handoff, type HandoffDeps, type HandoffRequest } from "../agent/handoff";
import { teamRoster } from "../agent/personas";
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
  const team = teamRoster(deps.db, { exclude: deps.currentAgentID });
  const nameOf = (agentID: string): string => {
    const row = deps.db
      .query<{ display_name: string | null; avatar_color: string | null }, [string]>(
        "SELECT display_name, avatar_color FROM agents WHERE id = ?",
      )
      .get(agentID);
    return row?.display_name?.trim() || team.find((member) => member.id === agentID)?.name || agentID;
  };
  const colorOf = (agentID: string): string | undefined => {
    const row = deps.db
      .query<{ avatar_color: string | null }, [string]>("SELECT avatar_color FROM agents WHERE id = ?")
      .get(agentID);
    return row?.avatar_color ?? undefined;
  };
  /** Append a durable channel message and stream it, so reloads and live agree. */
  const post = (
    fromType: "user" | "agent" | "system",
    fromID: string,
    text: string,
    uiHint?: "onboarding_name_prompt" | "handoff_notice" | "normal",
    toAgentID?: string,
  ): void => {
    if (!deps.channelID) return;
    const row = appendChannelMessage(deps.db, {
      channelID: deps.channelID,
      fromType,
      fromID,
      text,
      uiHint: uiHint ?? null,
      toAgentID: toAgentID ?? null,
    });
    deps.emit({
      type: "msg.new", id: row.id, channelId: deps.channelID, fromType,
      fromId: fromID, senderName: nameOf(fromID), senderColor: colorOf(fromID),
      text, internal: false, uiHint: uiHint ?? "normal",
      // The target rides along, so the client can make the name a link to
      // that agent's chat.
      ...(toAgentID ? { toAgentId: toAgentID } : {}),
      createdAt: row.created_at,
    });
  };

  registry.register({
    name: "handoff",
    description:
      "Hand a sub-task to another agent and get its answer back as this call's result. " +
      "Use it whenever the request is another agent's job — research, coding, or analysis — instead of doing it yourself. " +
      "Give a focused brief: what to do, and any context it needs to start. The other agent's answer appears in the user's chat, " +
      "so you do not need to repeat it verbatim; say what it means.",
    kind: "static",
    timeoutMs: 120_000,
    schema: objectSchema({
      toAgentID: team.length > 0
        ? { type: "string", enum: team.map((member) => member.id), description: team.map((member) => `${member.id}: ${member.role}`).join("; ") }
        : stringProp,
      task: { type: "string", minLength: 1, description: "The brief for the other agent." },
      context: { type: "string", minLength: 1, description: "Optional extra context for the other agent." },
    }, ["toAgentID", "task"]),
    handler: async (args: Record<string, unknown>) => {
      const toAgentID = String(args.toAgentID ?? "").trim();
      if (!toAgentID) throw new Error("handoff requires a toAgentID");
      if (team.length > 0 && !team.some((member) => member.id === toAgentID)) {
        throw new Error(`unknown agent ${toAgentID}; the team is ${team.map((member) => member.id).join(", ")}`);
      }
      const task = String(args.task ?? "").trim();
      if (!task) throw new Error("handoff requires a task");

      // The user sees who was asked, before the work starts — this is the
      // "message this bot" line they asked for. The brief is internal
      // routing: it belongs in the tool call, not in the chat. The target
      // rides along, so the name can be a link to that agent's chat.
      post("system", deps.currentAgentID, `Messaged ${nameOf(toAgentID)}`, "handoff_notice", toAgentID);
      if (deps.channelID) {
        deps.emit({
          type: "status.update", channelId: deps.channelID, agentId: deps.currentAgentID,
          text: `Waiting on ${nameOf(toAgentID)}…`, transient: true,
        });
      }

      const request: HandoffRequest = {
        toAgentID,
        task,
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
      // The specialist's answer is part of the user-visible flow, not just a
      // tool result: it lands as a message from that agent, and the delegating
      // agent's own reply follows it.
      if (result.text.trim()) post("agent", result.agentID, result.text);
      return {
        childTurnID: result.childTurnID,
        agentID: result.agentID,
        agentName: nameOf(result.agentID),
        depth: result.depth,
        stopReason: result.stopReason,
        text: result.text,
      };
    },
  });
}
