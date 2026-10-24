export type ToolRisk = "read" | "write" | "exec" | "network";
export type RuntimeType = "node" | "python" | "wasm" | "none";

export const HOOK_EVENTS = ["session.start", "session.end", "prompt.before", "model.request.before", "model.response.after", "tool.before", "tool.after"] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

export interface ToolContribution {
  name: string;
  title?: string;
  description: string;
  risk: ToolRisk;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface CommandContribution {
  name: string;
  description: string;
  args?: string;
}

export interface HookContribution {
  event: HookEventName;
  order?: number;
  critical?: boolean;
  timeoutMs?: number;
}

export interface PanelContribution {
  id: string;
  title: string;
  entry: string;
  location: "sidebar" | "main";
  /** Host API methods the panel may call through postMessage (subset of the plugin's own capabilities). */
  capabilities?: string[];
}

export interface WidgetContribution {
  id: string;
  kind: "status" | "result-card";
  title: string;
  /** For status widgets: a storage key whose value the host renders. For result cards: the tool name. */
  source: string;
  template?: string;
}

export interface PermissionRequest {
  id: string;
  scope?: unknown;
  reason: string;
}

export interface Manifest {
  $schema?: string;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: { name: string; url?: string; email?: string };
  license?: string;
  icon?: string;
  homepage?: string;
  engines: { harness: string };
  runtime: { type: RuntimeType; entry?: string; protocol?: number[]; python?: string };
  activation?: string[];
  contributes?: {
    tools?: ToolContribution[];
    commands?: CommandContribution[];
    hooks?: HookContribution[];
    panels?: PanelContribution[];
    widgets?: WidgetContribution[];
    skills?: string;
  };
  permissions?: { required?: PermissionRequest[]; optional?: PermissionRequest[] };
  configSchema?: Record<string, unknown>;
  limits?: { callTimeoutMs?: number; memoryMb?: number; hookTimeoutMs?: number };
}

export const MANIFEST_FILE = "harness.plugin.json";
