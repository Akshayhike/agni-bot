/**
 * Tool registry. Every tool declares a schema and a timeout before it can be
 * registered; the instant lane never calls tools (S3) — the task lane (P2+)
 * executes them through this registry only.
 *
 * No tools are registered at P0. Native tools (memory, links, tasks) arrive
 * with their stores in P2; shell/files/Gmail arrive with their approvals.
 */

export interface ToolContext {
  threadID: string;
  turnID: string;
  signal: AbortSignal;
}

export interface ToolDefinition<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  /** JSON-schema-shaped argument description, surfaced to the model. */
  schema: unknown;
  timeoutMs: number;
  handler: (args: Args, ctx: ToolContext) => Promise<Result>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<never, unknown>>();

  register<Args, Result>(definition: ToolDefinition<Args, Result>): void {
    if (this.tools.has(definition.name)) throw new Error(`tool already registered: ${definition.name}`);
    if (!(definition.timeoutMs > 0)) throw new Error(`tool must declare a positive timeout: ${definition.name}`);
    this.tools.set(definition.name, definition as ToolDefinition<never, unknown>);
  }

  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<never, unknown>[] {
    return [...this.tools.values()];
  }

  /** Intersect a persona's allowlist with what is actually registered. */
  allowlist(names: string[]): ToolDefinition<never, unknown>[] {
    return names.map((name) => this.tools.get(name)).filter((tool): tool is ToolDefinition<never, unknown> => Boolean(tool));
  }
}

export const toolRegistry = new ToolRegistry();
