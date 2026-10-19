/**
 * Register the `rename_agent` tool on a task-lane registry.
 *
 * Like the handoff tool this is a closure over the running turn's emit, so it
 * is registered per-turn rather than in the static registry: a rename has to
 * publish `agent.updated` for every connected client to refresh its roster.
 *
 * Why a tool and not prose: chat runs the task lane, so this is the difference
 * between the agent saying "Baahu it is" and the agent actually being Baahu.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { renameAgent } from "../agent/identity";
import type { ToolRegistry } from "./registry";

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

const MAX_NAME_CHARS = 64;

export interface RenameToolDeps {
  db: Database;
  emit: (frame: ServerFrameBody) => void;
  /** The agent running this turn; the default rename target. */
  currentAgentID: string;
}

export function registerRenameTool(registry: ToolRegistry, deps: RenameToolDeps): void {
  if (registry.get("rename_agent")) return;
  registry.register({
    name: "rename_agent",
    description:
      "Rename an agent in the app — yourself unless agentId says otherwise. Call this whenever the user " +
      "asks you to go by a different name (\"call yourself Baahu\", \"I'll call you Baahu\", \"rename " +
      "yourself to X\", \"your name is X\"); do not merely agree in prose. The name is persisted and shown " +
      "in the app. Confirm the change in your reply.",
    kind: "static",
    schema: objectSchema(
      {
        name: { type: "string", minLength: 1, maxLength: 64 },
        agentId: { type: "string", minLength: 1, maxLength: 64 },
      },
      ["name"],
    ),
    timeoutMs: 2_000,
    handler: async (args: Record<string, unknown>) => {
      const target = args.agentId === undefined ? deps.currentAgentID : String(args.agentId).trim();
      const result = renameAgent(deps.db, target, String(args.name));
      if (!result.ok) return { ok: false, error: result.reason };
      deps.emit({
        type: "agent.updated",
        agentId: result.agentID,
        displayName: result.name,
        onboarded: true,
      });
      return { ok: true, agentId: result.agentID, previousName: result.previousName, name: result.name };
    },
  });
}
