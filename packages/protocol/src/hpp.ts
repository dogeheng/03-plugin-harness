/**
 * Harness Plugin Protocol (HPP) v1 message shapes (report sections 4.5 and 4.6).
 */
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;

export const Methods = {
  initialize: "initialize",
  initialized: "initialized",
  shutdown: "shutdown",
  toolCall: "tool/call",
  commandRun: "command/run",
  hookInvoke: "hook/invoke",
  configDidChange: "config/didChange",
  grantsDidChange: "grants/didChange",
  ping: "$/ping",
  cancelRequest: "$/cancelRequest",
  progress: "$/progress",
  // plugin -> host
  fsRead: "host/fs.read",
  fsWrite: "host/fs.write",
  fsList: "host/fs.list",
  netFetch: "host/net.fetch",
  processExec: "host/process.exec",
  secretsRead: "host/secrets.read",
  storageGet: "host/storage.get",
  storageSet: "host/storage.set",
  storageDelete: "host/storage.delete",
  llmGenerate: "host/llm.generate",
  uiNotify: "host/ui.notify",
  uiConfirm: "host/ui.confirm",
  uiInput: "host/ui.input",
  sessionContext: "host/session.context",
  toolsInvoke: "host/tools.invoke",
  permissionsRequest: "host/permissions.request",
  log: "host/log",
} as const;

export interface Grant {
  permission: string;
  scope?: unknown;
}

export interface InitializeParams {
  protocolVersions: number[];
  host: { name: string; version: string };
  plugin: { id: string; version: string };
  grants: Grant[];
  config: Record<string, unknown>;
  workspace: { root: string | null };
  paths: { pluginData: string };
  limits: { callTimeoutMs: number; hookTimeoutMs: number };
  dev: boolean;
}

export interface Registrations {
  tools?: Array<{ name: string }>;
  hooks?: Array<{ event: string; order?: number; critical?: boolean }>;
  commands?: Array<{ name: string }>;
}

export interface InitializeResult {
  protocolVersion: number;
  plugin?: { name?: string; sdk?: string };
  registrations: Registrations;
}

export interface SessionRef {
  id: string;
  turnId?: string;
  workspace: string | null;
}

export interface ToolCallParams {
  name: string;
  arguments: unknown;
  callId: string;
  deadlineMs: number;
  session?: SessionRef;
}

export type ContentBlock = { type: "text"; text: string } | { type: "json"; json: unknown };

export interface ToolCallResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface CommandRunParams {
  name: string;
  args: string[];
  session?: SessionRef;
}

export interface CommandRunResult {
  markdown?: string;
  content?: ContentBlock[];
  /** Host-side actions the user may confirm (the plugin itself has no side effects). */
  actions?: Array<{
    id: string;
    label: string;
    kind: "write-file";
    /** Relative to the workspace. */
    path: string;
    content: string;
    /** create (default, fails if the file exists) | overwrite | prepend (below a leading "# Title"). */
    mode?: "create" | "overwrite" | "prepend";
  }>;
}

export interface HookInvokeParams {
  event: string;
  payload: unknown;
  session?: SessionRef;
}

export type JsonPatchOp =
  | { op: "replace" | "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type HookDecision =
  | { action: "continue"; note?: string }
  | { action: "modify"; patch: JsonPatchOp[]; note?: string }
  | { action: "block"; reason: string; rule?: string };

// ---- host functions ---------------------------------------------------------

export interface ExecParams {
  cmd: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
}

export interface FetchParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export interface FsReadParams {
  path: string;
  encoding?: "utf8" | "base64";
  maxBytes?: number;
}

export interface FsListParams {
  path: string;
}

export interface LlmGenerateParams {
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
}

export interface PermissionRequestParams {
  permission: string;
  scope?: unknown;
  reason: string;
}

export interface LogParams {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: unknown;
}
