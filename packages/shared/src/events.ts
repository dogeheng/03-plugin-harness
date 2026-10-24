/**
 * Events streamed from the daemon to clients (CLI NDJSON streams and the Web UI
 * WebSocket). Keep this file dependency-free: the web app imports it as types.
 */
export type ToolRisk = "read" | "write" | "exec" | "network";

export interface ErrorInfo {
  code: number;
  name?: string;
  message: string;
  data?: unknown;
}

export type TurnEvent =
  | { type: "turn.start"; sessionId: string; turnId: string }
  | { type: "text.delta"; sessionId: string; turnId: string; text: string }
  | { type: "tool.call"; sessionId: string; turnId: string; callId: string; toolName: string; pluginId: string | null; input: unknown; risk: ToolRisk }
  | {
      type: "tool.result";
      sessionId: string;
      turnId: string;
      callId: string;
      toolName: string;
      pluginId: string | null;
      ok: boolean;
      output?: unknown;
      error?: ErrorInfo;
      durationMs: number;
      blockedBy?: string;
    }
  | { type: "approval.request"; sessionId: string; turnId: string; approvalId: string; toolName: string; pluginId: string | null; input: unknown; risk: ToolRisk }
  | { type: "approval.resolved"; sessionId: string; approvalId: string; approved: boolean }
  | { type: "notice"; sessionId: string; turnId: string; level: "info" | "warn" | "error"; message: string; pluginId?: string | null }
  | { type: "turn.error"; sessionId: string; turnId: string; error: ErrorInfo }
  | { type: "turn.end"; sessionId: string; turnId: string; text: string; usage?: { inputTokens?: number; outputTokens?: number }; durationMs: number };

export type PluginState =
  | "discovered"
  | "rejected"
  | "validated"
  | "installed"
  | "enabled"
  | "activating"
  | "active"
  | "idle"
  | "failed"
  | "quarantined"
  | "disabled"
  | "updating"
  | "incompatible";

export type HostEvent =
  | TurnEvent
  | { type: "plugin.state"; pluginId: string; state: PluginState; detail?: string }
  | { type: "plugin.error"; pluginId: string; phase: string; error: ErrorInfo; action: string; suggestion?: string }
  | { type: "plugin.log"; pluginId: string; level: string; message: string; ts: string }
  | { type: "permission.request"; requestId: string; pluginId: string; pluginName?: string; permission: string; label?: string; risk?: string; scope?: string; reason?: string; sessionId?: string }
  | { type: "confirm.request"; requestId: string; pluginId: string; pluginName?: string; message: string; sessionId?: string }
  | { type: "permission.resolved"; requestId: string; decision: "once" | "always" | "deny"; sessionId?: string }
  | { type: "plugins.changed" }
  | { type: "ui.notify"; pluginId: string; level: "info" | "warn" | "error"; message: string }
  | { type: "hpp.trace"; pluginId: string; direction: "in" | "out"; message: unknown; ts: string };
