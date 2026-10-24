import { PassThrough } from "node:stream";
import {
  type CommandRunResult,
  type Grant,
  type HookDecision,
  type InitializeResult,
  Methods,
  ndjsonTransport,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  RpcPeer,
  type ToolCallResult,
} from "@harness/protocol";
import { type PluginDefinition, serve } from "./index.ts";

export interface MockHostOptions {
  pluginId?: string;
  version?: string;
  workspace?: string | null;
  config?: Record<string, unknown>;
  grants?: Grant[];
  /** Override host functions, keyed by HPP method (e.g. "host/process.exec"). */
  handlers?: Record<string, (params: unknown) => unknown | Promise<unknown>>;
}

export interface MockHost {
  init: InitializeResult;
  peer: RpcPeer;
  logs: Array<{ level: string; message: string; data?: unknown }>;
  calls: Array<{ method: string; params: unknown }>;
  callTool(name: string, args?: unknown, opts?: { timeoutMs?: number }): Promise<ToolCallResult>;
  runCommand(name: string, args?: string[]): Promise<CommandRunResult>;
  invokeHook(event: string, payload: unknown): Promise<HookDecision>;
  close(): Promise<void>;
}

/**
 * Starts a plugin definition against an in-memory host. Host functions that are
 * not overridden fail with PermissionDenied, mirroring a host with no grants.
 */
export async function createMockHost(def: PluginDefinition, opts: MockHostOptions = {}): Promise<MockHost> {
  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();
  serve(def, ndjsonTransport(hostToPlugin, pluginToHost));
  const peer = new RpcPeer(ndjsonTransport(pluginToHost, hostToPlugin));
  const logs: MockHost["logs"] = [];
  const calls: MockHost["calls"] = [];
  const storage = new Map<string, unknown>();
  peer.onNotification(Methods.log, (p) => logs.push(p as MockHost["logs"][number]));
  const defaults: Record<string, (params: unknown) => unknown> = {
    [Methods.storageGet]: (p) => ({ value: storage.get((p as { key: string }).key) ?? null }),
    [Methods.storageSet]: (p) => {
      storage.set((p as { key: string }).key, (p as { value: unknown }).value);
      return { ok: true };
    },
    [Methods.storageDelete]: (p) => {
      storage.delete((p as { key: string }).key);
      return { ok: true };
    },
    [Methods.uiNotify]: () => ({ ok: true }),
  };
  for (const m of Object.values(Methods)) {
    if (!m.startsWith("host/") || m === Methods.log) continue;
    peer.handle(m, async (params) => {
      calls.push({ method: m, params });
      const h = opts.handlers?.[m] ?? defaults[m];
      if (!h) throw new RpcError(RpcErrorCode.PermissionDenied, `mock host: ${m} is not granted`);
      return h(params);
    });
  }
  const init = await peer.request<InitializeResult>(Methods.initialize, {
    protocolVersions: [PROTOCOL_VERSION],
    host: { name: "harness-testkit", version: "0.0.0" },
    plugin: { id: opts.pluginId ?? "dev.test.plugin", version: opts.version ?? "0.0.0" },
    grants: opts.grants ?? [],
    config: opts.config ?? {},
    workspace: { root: opts.workspace ?? null },
    paths: { pluginData: "/tmp/harness-testkit-data" },
    limits: { callTimeoutMs: 30_000, hookTimeoutMs: 2_000 },
    dev: true,
  });
  peer.notify(Methods.initialized, {});
  return {
    init,
    peer,
    logs,
    calls,
    callTool: (name, args = {}, o) => peer.request<ToolCallResult>(Methods.toolCall, { name, arguments: args, callId: `call_${Date.now()}`, deadlineMs: Date.now() + 30_000 }, { timeoutMs: o?.timeoutMs ?? 30_000 }),
    runCommand: (name, args = []) => peer.request<CommandRunResult>(Methods.commandRun, { name, args }),
    invokeHook: (event, payload) => peer.request<HookDecision>(Methods.hookInvoke, { event, payload }),
    close: async () => {
      await peer.request(Methods.shutdown, { reason: "test" }).catch(() => {});
      peer.close();
    },
  };
}
