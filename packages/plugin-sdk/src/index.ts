import {
  type CommandRunParams,
  type CommandRunResult,
  type ExecParams,
  type ExecResult,
  type FetchParams,
  type FetchResult,
  type Grant,
  type HookDecision,
  type HookInvokeParams,
  type InitializeParams,
  type InitializeResult,
  type LineTransport,
  Methods,
  ndjsonTransport,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  RpcPeer,
  type SessionRef,
  type ToolCallParams,
  type ToolCallResult,
} from "@harness/protocol";
import { z } from "zod";

export { z };
export type { HookDecision, CommandRunResult, ExecResult, FetchResult, SessionRef };

export const SDK_VERSION = "1.0.0";

/** A structured, expected tool failure (e.g. not_a_repository). The model sees `{ error: code, message }`. */
export class ToolError extends Error {
  readonly code: string;
  readonly data?: Record<string, unknown>;
  constructor(code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.data = data;
  }
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface HostApi {
  fs: {
    read(path: string, opts?: { encoding?: "utf8" | "base64"; maxBytes?: number }): Promise<{ content: string; size: number; truncated: boolean }>;
    list(path: string): Promise<{ entries: Array<{ name: string; type: "file" | "dir" | "other"; size: number }> }>;
    write(path: string, content: string): Promise<{ bytes: number }>;
  };
  net: { fetch(url: string, init?: Omit<FetchParams, "url">): Promise<FetchResult & { json<T = unknown>(): T }> };
  process: { exec(cmd: string, args: string[], opts?: Omit<ExecParams, "cmd" | "args">): Promise<ExecResult> };
  secrets: { read(key: string): Promise<string | null> };
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown, opts?: { ttlSec?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  llm: { generate(params: { prompt: string; system?: string; maxOutputTokens?: number }): Promise<{ text: string; usage?: unknown }> };
  ui: {
    notify(message: string, level?: "info" | "warn" | "error"): Promise<void>;
    confirm(message: string): Promise<boolean>;
  };
  permissions: { request(permission: string, scope: unknown, reason: string): Promise<{ granted: boolean; decision: string }> };
}

export interface PluginContext {
  plugin: { id: string; version: string };
  workspace: { root: string | null };
  config: Record<string, unknown>;
  grants: Grant[];
  paths: { pluginData: string };
  dev: boolean;
  log: Logger;
  host: HostApi;
  hasPermission(id: string): boolean;
}

export interface CallContext extends PluginContext {
  signal: AbortSignal;
  session?: SessionRef;
  callId?: string;
  progress(value: unknown): void;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  input?: S;
  execute(input: z.output<S>, ctx: CallContext): unknown | Promise<unknown>;
}

export interface CommandDef {
  run(args: string[], ctx: CallContext): string | CommandRunResult | Promise<string | CommandRunResult>;
}

export type HookHandler = (payload: unknown, ctx: CallContext) => HookDecision | undefined | Promise<HookDecision | undefined>;

export interface PluginDefinition {
  activate?(ctx: PluginContext): void | Promise<void>;
  deactivate?(reason: string, ctx: PluginContext): void | Promise<void>;
  tools?: Record<string, ToolDef>;
  commands?: Record<string, CommandDef>;
  hooks?: Record<string, HookHandler>;
  onConfigChange?(config: Record<string, unknown>, ctx: PluginContext): void | Promise<void>;
}

export function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function command(def: CommandDef): CommandDef {
  return def;
}

function formatZodError(name: string, err: z.ZodError): string {
  const parts = err.issues.map((i) => `${i.path.length ? `/${i.path.join("/")}` : "/"}：${i.message}`);
  return `工具 ${name} 的参数不合法：${parts.join("；")}`;
}

function wrapResult(value: unknown): ToolCallResult {
  if (value && typeof value === "object" && Array.isArray((value as ToolCallResult).content) && "structuredContent" in (value as object)) return value as ToolCallResult;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }], structuredContent: typeof value === "string" ? { text: value } : (value ?? null) };
}

function makeHost(peer: RpcPeer, signalFor?: () => AbortSignal | undefined): HostApi {
  const req = <T>(method: string, params: unknown) => peer.request<T>(method, params, { signal: signalFor?.() });
  return {
    fs: {
      read: (path, opts) => req(Methods.fsRead, { path, ...opts }),
      list: (path) => req(Methods.fsList, { path }),
      write: (path, content) => req(Methods.fsWrite, { path, content }),
    },
    net: {
      fetch: async (url, init) => {
        const r = await req<FetchResult>(Methods.netFetch, { url, ...init });
        return { ...r, json: <T>() => JSON.parse(r.body) as T };
      },
    },
    process: { exec: (cmd, args, opts) => req(Methods.processExec, { cmd, args, ...opts }) },
    secrets: { read: async (key) => (await req<{ value: string | null }>(Methods.secretsRead, { key })).value },
    storage: {
      get: async (key) => (await req<{ value: unknown }>(Methods.storageGet, { key })).value as never,
      set: async (key, value, opts) => void (await req(Methods.storageSet, { key, value, ttlSec: opts?.ttlSec })),
      delete: async (key) => void (await req(Methods.storageDelete, { key })),
    },
    llm: { generate: (params) => req(Methods.llmGenerate, params) },
    ui: {
      notify: async (message, level = "info") => void (await req(Methods.uiNotify, { message, level })),
      confirm: async (message) => (await req<{ confirmed: boolean }>(Methods.uiConfirm, { message })).confirmed,
    },
    permissions: { request: (permission, scope, reason) => req(Methods.permissionsRequest, { permission, scope, reason }) },
  };
}

/**
 * Serves a plugin definition over a line transport. Used by the stdio runner
 * and by the testkit (in-memory transport).
 */
export function serve(def: PluginDefinition, transport: LineTransport, opts: { onExit?: (code: number) => void } = {}): RpcPeer {
  const peer = new RpcPeer(transport);
  let ctx: PluginContext | null = null;
  const log: Logger = {
    debug: (message, data) => peer.notify(Methods.log, { level: "debug", message, data }),
    info: (message, data) => peer.notify(Methods.log, { level: "info", message, data }),
    warn: (message, data) => peer.notify(Methods.log, { level: "warn", message, data }),
    error: (message, data) => peer.notify(Methods.log, { level: "error", message, data }),
  };
  const requireCtx = (): PluginContext => {
    if (!ctx) throw new RpcError(RpcErrorCode.NotActive, "plugin is not initialized");
    return ctx;
  };
  const callCtx = (signal: AbortSignal, progress: (v: unknown) => void, session?: SessionRef, callId?: string): CallContext => {
    const base = requireCtx();
    return { ...base, host: makeHost(peer, () => signal), signal, progress, session, callId };
  };

  peer.handle(Methods.initialize, async (raw) => {
    const p = raw as InitializeParams;
    if (!p?.protocolVersions?.includes(PROTOCOL_VERSION)) {
      throw new RpcError(RpcErrorCode.IncompatibleProtocol, `SDK 只支持 HPP v${PROTOCOL_VERSION}，宿主提供 [${p?.protocolVersions?.join(", ")}]`);
    }
    ctx = {
      plugin: p.plugin,
      workspace: p.workspace,
      config: p.config ?? {},
      grants: p.grants ?? [],
      paths: p.paths,
      dev: p.dev,
      log,
      host: makeHost(peer),
      hasPermission: (id) => (ctx?.grants ?? []).some((g) => g.permission === id),
    };
    await def.activate?.(ctx);
    const result: InitializeResult = {
      protocolVersion: PROTOCOL_VERSION,
      plugin: { sdk: `ts/${SDK_VERSION}` },
      registrations: {
        tools: Object.keys(def.tools ?? {}).map((name) => ({ name })),
        commands: Object.keys(def.commands ?? {}).map((name) => ({ name })),
        hooks: Object.keys(def.hooks ?? {}).map((event) => ({ event })),
      },
    };
    return result;
  });

  peer.onNotification(Methods.initialized, () => {});
  peer.handle(Methods.ping, () => ({ pong: Date.now() }));

  peer.handle(Methods.toolCall, async (raw, rc) => {
    const p = raw as ToolCallParams;
    const t = def.tools?.[p.name];
    if (!t) throw new RpcError(RpcErrorCode.MethodNotFound, `插件没有实现工具 ${p.name}`);
    let input: unknown = p.arguments ?? {};
    if (t.input) {
      const parsed = t.input.safeParse(input);
      if (!parsed.success) throw new RpcError(RpcErrorCode.InvalidParams, formatZodError(p.name, parsed.error));
      input = parsed.data;
    }
    try {
      return wrapResult(await t.execute(input as never, callCtx(rc.signal, rc.progress, p.session, p.callId)));
    } catch (err) {
      if (err instanceof ToolError) {
        const payload = { error: err.code, message: err.message, ...err.data };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true } satisfies ToolCallResult;
      }
      if (err instanceof RpcError) throw err;
      throw new RpcError(RpcErrorCode.PluginError, (err as Error)?.message ?? String(err), { stack: ctx?.dev ? (err as Error)?.stack : undefined });
    }
  });

  peer.handle(Methods.commandRun, async (raw, rc) => {
    const p = raw as CommandRunParams;
    const c = def.commands?.[p.name];
    if (!c) throw new RpcError(RpcErrorCode.MethodNotFound, `插件没有实现命令 ${p.name}`);
    const out = await c.run(p.args ?? [], callCtx(rc.signal, rc.progress, p.session));
    return typeof out === "string" ? ({ markdown: out } satisfies CommandRunResult) : out;
  });

  peer.handle(Methods.hookInvoke, async (raw, rc) => {
    const p = raw as HookInvokeParams;
    const h = def.hooks?.[p.event];
    if (!h) return { action: "continue" } satisfies HookDecision;
    return (await h(p.payload, callCtx(rc.signal, rc.progress, p.session))) ?? { action: "continue" };
  });

  peer.onNotification(Methods.configDidChange, (raw) => {
    const cfg = (raw as { config: Record<string, unknown> })?.config ?? {};
    if (ctx) {
      ctx.config = cfg;
      void def.onConfigChange?.(cfg, ctx);
    }
  });
  peer.onNotification(Methods.grantsDidChange, (raw) => {
    if (ctx) ctx.grants = (raw as { grants: Grant[] })?.grants ?? [];
  });

  peer.handle(Methods.shutdown, async (raw) => {
    const reason = (raw as { reason?: string })?.reason ?? "shutdown";
    if (ctx) await def.deactivate?.(reason, ctx);
    setTimeout(() => opts.onExit?.(0), 10);
    return { ok: true };
  });
  return peer;
}

let started = false;

/** Starts the stdio server: stdout carries protocol frames only; console output goes to stderr. */
export function runStdio(def: PluginDefinition): void {
  if (started) return;
  started = true;
  const out = process.stdout;
  const toStderr = (...args: unknown[]) => process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[plugin] uncaught exception: ${err?.stack ?? err}\n`);
    process.exit(70);
  });
  process.on("unhandledRejection", (err) => process.stderr.write(`[plugin] unhandled rejection: ${(err as Error)?.stack ?? err}\n`));
  const transport = ndjsonTransport(process.stdin, out);
  transport.onClose(() => process.exit(0));
  serve(def, transport, { onExit: (code) => process.exit(code) });
}

/** Declares a plugin. Under the host (HARNESS_PROTOCOL=1) it starts serving on stdio automatically. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  if (typeof process !== "undefined" && process.env?.HARNESS_PROTOCOL === "1") queueMicrotask(() => runStdio(def));
  return def;
}
