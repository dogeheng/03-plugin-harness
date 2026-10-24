/**
 * Panel-side SDK for Harness UI panels (runs inside the sandboxed iframe).
 *
 * The panel has no network access (CSP connect-src 'none') and an opaque origin, so
 * everything goes through the host UI over postMessage JSON-RPC 2.0. Method names follow
 * MCP Apps where an equivalent exists:
 *
 *   panel -> host  ui/initialize                       -> { hostContext }
 *   panel -> host  ui/notifications/initialized        (notification)
 *   panel -> host  tools/call { name, arguments }      -> { ok, output }   (own plugin's tools only)
 *   panel -> host  ui/open-link { url }                -> { opened }       (user confirms)
 *   panel -> host  ui/notify { message, level }        (notification, shown as a toast)
 *   host -> panel  ui/notifications/host-context-changed { hostContext }
 *
 * Usage:
 *   import { connectHost } from "@harness/plugin-sdk/panel";
 *   const host = await connectHost();
 *   const { output } = await host.callTool("git_log", { limit: 30 });
 */

export const PANEL_PROTOCOL = "2026-01-26";

export interface HostContext {
  theme: "light" | "dark";
  /** Design tokens; applied as CSS variables --hx-<name> on <html>. */
  tokens: Record<string, string>;
  workspace: string | null;
  locale: string;
  pluginId: string;
  panelId: string;
  capabilities: string[];
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  output: T;
  durationMs?: number;
}

export interface PanelHost {
  readonly context: HostContext;
  callTool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<ToolResult<T>>;
  openLink(url: string): Promise<boolean>;
  notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
  onContextChange(cb: (ctx: HostContext) => void): () => void;
}

export class PanelBridgeError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "PanelBridgeError";
    this.code = code;
    this.data = data;
  }
}

/** The subset of `window` the bridge needs (lets tests run without a browser). */
export interface BridgeWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (ev: { data: unknown; source: unknown }) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: unknown; source: unknown }) => void): void;
  document?: { documentElement: { style: { setProperty(k: string, v: string): void }; dataset: Record<string, string | undefined> } };
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

export function applyTheme(ctx: HostContext, win: BridgeWindow | undefined = globalThis as unknown as BridgeWindow): void {
  const root = win?.document?.documentElement;
  if (!root) return;
  for (const [k, v] of Object.entries(ctx.tokens)) root.style.setProperty(`--hx-${k}`, v);
  root.style.setProperty("color-scheme", ctx.theme);
  root.dataset.theme = ctx.theme;
}

export async function connectHost(opts: { timeoutMs?: number; win?: BridgeWindow; applyTheme?: boolean } = {}): Promise<PanelHost> {
  const win = opts.win ?? (globalThis as unknown as BridgeWindow);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (!win.parent || (win.parent as unknown) === (win as unknown)) throw new PanelBridgeError(-32603, "面板必须在 Harness 界面中打开（当前不在 iframe 里）");
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(ctx: HostContext) => void>();
  let context: HostContext | null = null;

  const post = (msg: Record<string, unknown>) => win.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*");
  const request = (method: string, params: unknown, ms = timeoutMs): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new PanelBridgeError(-32002, `宿主没有在 ${ms}ms 内响应 ${method}`));
      }, ms);
      pending.set(id, { resolve, reject, timer });
      post({ id, method, params });
    });

  const onMessage = (ev: { data: unknown; source: unknown }) => {
    if (ev.source !== win.parent) return; // only the embedding host UI may talk to us
    const m = ev.data as { jsonrpc?: string; id?: number; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string; params?: unknown };
    if (!m || m.jsonrpc !== "2.0") return;
    if (typeof m.id === "number" && !m.method) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new PanelBridgeError(m.error.code, m.error.message, m.error.data));
      else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/host-context-changed") {
      const next = (m.params as { hostContext?: HostContext })?.hostContext;
      if (!next) return;
      context = next;
      if (opts.applyTheme !== false) applyTheme(next, win);
      for (const cb of listeners) cb(next);
    }
  };
  win.addEventListener("message", onMessage);

  const init = (await request("ui/initialize", { protocolVersion: PANEL_PROTOCOL, appInfo: { name: "harness-panel", version: "1" } }, Math.min(timeoutMs, 10_000)).catch((e) => {
    win.removeEventListener("message", onMessage);
    throw e;
  })) as { hostContext: HostContext };
  context = init.hostContext;
  if (opts.applyTheme !== false) applyTheme(context, win);
  post({ method: "ui/notifications/initialized", params: {} });

  return {
    get context() {
      return context as HostContext;
    },
    callTool: <T>(name: string, args: Record<string, unknown> = {}) => request("tools/call", { name, arguments: args }) as Promise<ToolResult<T>>,
    openLink: async (url: string) => ((await request("ui/open-link", { url }, 5 * 60_000)) as { opened: boolean }).opened,
    notify: (message, level = "info") => post({ method: "ui/notify", params: { message, level } }),
    onContextChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
