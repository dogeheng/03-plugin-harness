import type { ToolRisk } from "@harness/shared";
import { newId } from "@harness/shared";
import type { EventBus } from "../events/bus.ts";

export type JsonSchema = Record<string, unknown>;

export interface ToolExecContext {
  sessionId: string;
  turnId: string;
  callId: string;
  workspace: string | null;
  signal: AbortSignal;
}

export interface RegisteredTool {
  /** Model-visible name, unique across the registry. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  risk: ToolRisk;
  /** null for host-builtin tools. */
  pluginId: string | null;
  timeoutMs: number;
  execute(input: unknown, ctx: ToolExecContext): Promise<unknown>;
}

export interface ToolSource {
  readonly id: string;
  listTools(): RegisteredTool[];
}

/**
 * An expected, structured tool failure (e.g. `not_a_repository`). The UI shows it
 * as a failed call; the model receives `payload` verbatim so it can react.
 */
export class ToolFailure extends Error {
  readonly payload: { error: string; message: string; [k: string]: unknown };
  constructor(payload: { error: string; message: string; [k: string]: unknown }) {
    super(payload.message);
    this.name = "ToolFailure";
    this.payload = payload;
  }
}

/** Aggregates tools contributed by all sources (plugins). Hosts ships with no domain tools. */
export class ToolRegistry {
  private readonly sources = new Map<string, ToolSource>();

  addSource(source: ToolSource): void {
    this.sources.set(source.id, source);
  }

  removeSource(id: string): void {
    this.sources.delete(id);
  }

  list(): RegisteredTool[] {
    const seen = new Map<string, RegisteredTool>();
    for (const s of this.sources.values()) {
      for (const t of s.listTools()) if (!seen.has(t.name)) seen.set(t.name, t);
    }
    return [...seen.values()];
  }

  get(name: string): RegisteredTool | undefined {
    return this.list().find((t) => t.name === name);
  }
}

export type HookEvent = "session.start" | "session.end" | "prompt.before" | "model.request.before" | "model.response.after" | "tool.before" | "tool.after";

export interface HookOutcome<T> {
  payload: T;
  blocked?: { reason: string; pluginId: string; rule?: string };
  notes: Array<{ pluginId: string; note: string }>;
}

export interface HookRunner {
  run<T>(event: HookEvent, payload: T, meta: { sessionId: string; turnId: string }): Promise<HookOutcome<T>>;
}

export const noopHooks: HookRunner = {
  async run(_event, payload) {
    return { payload, notes: [] };
  },
};

interface PendingApproval {
  resolve: (approved: boolean) => void;
  sessionId: string;
  timer: NodeJS.Timeout;
}

/** Holds tool calls that need a human decision until a client answers. */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly bus: EventBus;
  private readonly timeoutMs: number;
  constructor(bus: EventBus, timeoutMs = 5 * 60_000) {
    this.bus = bus;
    this.timeoutMs = timeoutMs;
  }

  request(args: { sessionId: string; turnId: string; toolName: string; pluginId: string | null; input: unknown; risk: ToolRisk }, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const approvalId = newId("apr");
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => {
        const p = this.pending.get(approvalId);
        if (!p) return;
        clearTimeout(p.timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(approvalId);
        this.bus.emit({ type: "approval.resolved", sessionId: args.sessionId, approvalId, approved });
        resolve(approved);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      this.pending.set(approvalId, { resolve: finish, sessionId: args.sessionId, timer });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.bus.emit({ type: "approval.request", approvalId, ...args });
    });
  }

  resolve(approvalId: string, approved: boolean): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    p.resolve(approved);
    return true;
  }

  list(): string[] {
    return [...this.pending.keys()];
  }
}
