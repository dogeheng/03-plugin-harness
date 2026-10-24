/**
 * Host side of the panel bridge (the UI end of @harness/plugin-sdk/panel).
 *
 * Trust model: the panel is untrusted. It runs in a sandboxed iframe on another origin with
 * no network access, so this bridge is its only way to reach anything. We
 *   - accept messages only from that iframe's window (event.source), never by origin
 *     (a sandboxed document's origin is the opaque "null");
 *   - expose a fixed method set; everything else gets MethodNotFound;
 *   - route tools/call through the daemon, which enforces "own plugin's tools only",
 *     the panel's declared capabilities and confirmation for side-effecting tools;
 *   - rate-limit requests and notifications so a panel cannot flood the UI.
 */

export const PANEL_PROTOCOL = "2026-01-26";

export interface HostContext {
  theme: "light" | "dark";
  tokens: Record<string, string>;
  workspace: string | null;
  locale: string;
  pluginId: string;
  panelId: string;
  capabilities: string[];
}

export interface BridgeError {
  code: number;
  message: string;
  data?: unknown;
}

export interface HostBridgeDeps {
  context(): HostContext;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  openLink(url: string): Promise<boolean>;
  notify(message: string, level: "info" | "success" | "warning" | "error"): void;
  /** Called once the panel finished its handshake. */
  onReady?(): void;
  /** Called for protocol violations (shown in the panel's error strip). */
  onViolation?(message: string): void;
}

export interface FrameLike {
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export interface EventSourceLike {
  addEventListener(type: "message", fn: (ev: { data: unknown; source: unknown }) => void): void;
  removeEventListener(type: "message", fn: (ev: { data: unknown; source: unknown }) => void): void;
}

export const LIMITS = { maxInflight: 8, requestsPerMinute: 120, notifyPer10s: 5, maxMessageBytes: 256 * 1024 };

const toError = (e: unknown): BridgeError => {
  const x = e as { code?: unknown; message?: unknown; data?: unknown };
  return { code: typeof x?.code === "number" ? x.code : -32603, message: typeof x?.message === "string" ? x.message : String(e), data: x?.data };
};

export function attachPanelBridge(frame: FrameLike, deps: HostBridgeDeps, win: EventSourceLike = window): { pushContext(): void; dispose(): void } {
  let inflight = 0;
  let initialized = false;
  const recent: number[] = [];
  const notifies: number[] = [];

  const post = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...msg }, "*");
  const allow = (log: number[], max: number, windowMs: number) => {
    const now = Date.now();
    while (log.length && now - log[0] > windowMs) log.shift();
    if (log.length >= max) return false;
    log.push(now);
    return true;
  };

  const handle = async (m: { id?: unknown; method: string; params?: unknown }) => {
    const id = typeof m.id === "number" || typeof m.id === "string" ? m.id : undefined;
    const reply = (r: { result?: unknown; error?: BridgeError }) => {
      if (id !== undefined) post({ id, ...r });
    };
    const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;

    // Notifications (no reply).
    if (m.method === "ui/notifications/initialized") {
      if (!initialized) {
        initialized = true;
        deps.onReady?.();
      }
      return;
    }
    if (m.method === "ui/notify") {
      if (!allow(notifies, LIMITS.notifyPer10s, 10_000)) return;
      const level = ["info", "success", "warning", "error"].includes(String(params.level)) ? (params.level as "info") : "info";
      deps.notify(String(params.message ?? "").slice(0, 300), level);
      return;
    }
    if (id === undefined) return; // unknown notification: ignore

    if (!allow(recent, LIMITS.requestsPerMinute, 60_000)) return reply({ error: { code: -32006, message: "面板请求过于频繁，请稍后再试" } });
    if (inflight >= LIMITS.maxInflight) return reply({ error: { code: -32006, message: `同时进行的请求不能超过 ${LIMITS.maxInflight} 个` } });

    inflight++;
    try {
      switch (m.method) {
        case "ui/initialize":
          return reply({ result: { protocolVersion: PANEL_PROTOCOL, hostInfo: { name: "harness", version: "0.1" }, hostContext: deps.context() } });
        case "tools/call": {
          const name = params.name;
          if (typeof name !== "string" || !name) return reply({ error: { code: -32602, message: "tools/call 缺少 name" } });
          const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
          return reply({ result: await deps.callTool(name, args) });
        }
        case "ui/open-link": {
          const url = String(params.url ?? "");
          let ok = false;
          try {
            ok = ["http:", "https:"].includes(new URL(url).protocol);
          } catch {
            ok = false;
          }
          if (!ok) return reply({ error: { code: -32602, message: "只能打开 http(s) 链接" } });
          return reply({ result: { opened: await deps.openLink(url) } });
        }
        default:
          return reply({ error: { code: -32601, message: `宿主不支持的方法：${m.method}` } });
      }
    } catch (e) {
      reply({ error: toError(e) });
    } finally {
      inflight--;
    }
  };

  const onMessage = (ev: { data: unknown; source: unknown }) => {
    if (!frame.contentWindow || ev.source !== frame.contentWindow) return;
    const m = ev.data as { jsonrpc?: unknown; method?: unknown; id?: unknown; params?: unknown } | null;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") return;
    let size = 0;
    try {
      size = JSON.stringify(m).length;
    } catch {
      size = Number.POSITIVE_INFINITY;
    }
    if (size > LIMITS.maxMessageBytes) {
      deps.onViolation?.(`面板发送的消息过大（${size} 字节），已丢弃`);
      return;
    }
    void handle(m as { id?: unknown; method: string; params?: unknown });
  };

  win.addEventListener("message", onMessage);
  return {
    pushContext: () => {
      if (initialized) post({ method: "ui/notifications/host-context-changed", params: { hostContext: deps.context() } });
    },
    dispose: () => win.removeEventListener("message", onMessage),
  };
}
