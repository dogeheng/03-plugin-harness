/** Thin, typed client for the daemon's local HTTP API (same origin, cookie auth). */

export interface ErrorBody {
  code: number;
  name?: string;
  message: string;
  data?: { hint?: string; [k: string]: unknown };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly data: ErrorBody["data"];
  constructor(status: number, body: ErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.data = body.data;
  }
  get hint(): string | undefined {
    return typeof this.data?.hint === "string" ? this.data.hint : undefined;
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
    signal: opts.signal,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (should not happen for /api)
  }
  if (!res.ok) {
    const err = (json as { error?: ErrorBody } | null)?.error ?? { code: res.status, message: text || res.statusText };
    throw new ApiError(res.status, err);
  }
  return json as T;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- shapes returned by the daemon (kept in sync with apps/daemon) -------------------

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

export interface PermissionView {
  id: string;
  label: string;
  risk: "none" | "low" | "medium" | "high";
  explain: string;
  scope?: unknown;
  scopeText: string;
  reason: string;
  required: boolean;
  granted: boolean;
}

export interface PluginStats {
  calls: number;
  errors: number;
  timeouts: number;
  totalMs: number;
  activations: number;
  lastCallAt: string | null;
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string | null;
  runtime: string;
  dev: boolean;
  source: string;
  enabled: boolean;
  state: PluginState;
  stateDetail: string | null;
  lastError: { message: string; suggestion?: string; at?: string } | null;
  contributes: { tools: string[]; commands: string[]; hooks: string[]; panels: Array<{ id: string; title: string; location: string }>; skills: boolean };
  permissions: PermissionView[];
  stats: PluginStats | null;
  isolation: string[];
  sandboxed: boolean;
  pid: number | null;
}

export interface Issue {
  code: string;
  path?: string;
  message: string;
  hint?: string;
}

export interface PluginDetail extends PluginSummary {
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    homepage?: string;
    license?: string;
    configSchema?: JsonSchema;
    contributes?: { tools?: Array<{ name: string; title?: string; description: string; risk?: string }>; commands?: Array<{ name: string; description: string; args?: string }> };
    limits?: Record<string, number>;
    [k: string]: unknown;
  };
  dir: string;
  readme: string | null;
  changelog: string | null;
  grants: Array<{ id: string; permission: string; scope?: unknown; source: string; grantedAt: string; lastUsedAt: string | null }>;
  settings: Record<string, unknown>;
  secretKeys: string[];
  secretsConfigured: Record<string, boolean>;
  versions: Array<{ version: string; installedAt: string; verified: string | null }>;
  snapshot: { state: PluginState; pid: number | null; startedAt: string | null; crashes: number; inflight: number; sdk: { name?: string; version?: string } | null; [k: string]: unknown } | null;
  issues: Issue[];
  kvBytes: number;
}

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema & { "x-secret"?: boolean }>;
  required?: string[];
  "x-secret"?: boolean;
  [k: string]: unknown;
}

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime: string;
  dir: string;
  installed: string | null;
  updateAvailable: boolean;
  valid: boolean;
  problems: string[];
}

export interface InspectResult {
  source: string;
  kind: string;
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  incompatible: boolean;
  integrity: "ok" | "mismatch" | "none";
  manifest: (PluginDetail["manifest"] & { author?: { name?: string }; runtime: { type: string } }) | null;
  existing: { version: string; dev: boolean } | null;
  permissions: PermissionView[];
  isolation: string[];
}

export interface PanelInfo {
  pluginId: string;
  pluginName: string;
  panelId: string;
  title: string;
  location: "sidebar" | "main";
  capabilities: string[];
  url: string | null;
}

export interface Session {
  id: string;
  title: string;
  workspace: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  content: { role: string; content: unknown };
  createdAt: string;
}

export interface StoredToolCall {
  id: string;
  plugin_id: string | null;
  status: "ok" | "error" | "denied" | "blocked";
  error: string | null;
  duration_ms: number;
}

export interface CommandInfo {
  name: string;
  pluginId: string;
  pluginName?: string;
  description: string;
  args?: string;
}

export interface ActionView {
  id: string;
  pluginId: string;
  label: string;
  kind: "write-file";
  path: string;
  mode: "create" | "overwrite" | "prepend" | "append";
  bytes: number;
  exists: boolean;
  preview: string;
  expiresAt: string;
}

export interface CommandRunResult {
  pluginId: string;
  text?: string;
  markdown?: string;
  actions?: ActionView[];
  actionProblems?: string[];
}

export interface Provider {
  id: string;
  label: string;
  kind: string;
  defaultBaseURL?: string;
  requiresKey: boolean;
  exampleModels: string[];
  configured: boolean;
  baseURL: string | null;
}

export interface Status {
  version: string;
  pid: number;
  uptimeSec: number;
  port: number;
  socketPath: string;
  home: string;
  model: { provider: string; id: string };
  secretsBackend: string;
  tools: Array<{ name: string; pluginId: string | null; risk: string }>;
  subsystems: {
    plugins?: { installed: number; active: number; safeMode: boolean; sandbox: { mode: string; reason?: string; [k: string]: unknown } };
    panels?: { origin: string | null; panels: number };
    [k: string]: unknown;
  };
}

export interface HarnessConfig {
  model: { provider: string; id: string };
  providers: Record<string, { baseURL?: string }>;
  agent: { maxSteps: number; totalTimeoutMs: number };
  server: { port: number };
  approvals: Record<"read" | "write" | "exec" | "network", "auto" | "ask">;
  catalogs: string[];
  sandbox: string;
  workspace?: string;
}

export interface AuditEvent {
  id: number;
  ts: string;
  plugin_id: string | null;
  kind: string;
  permission: string | null;
  target: string | null;
  decision: string;
  detail: string | null;
}
