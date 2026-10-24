import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { ErrorCode, HarnessError, type HostEvent } from "@harness/shared";
import { Hono, type Context } from "hono";
import type { Daemon } from "../daemon.ts";
import { BUILTIN_PROVIDERS, getProviderInfo } from "../models/providers.ts";
import { providerService } from "../secrets/store.ts";

export type Transport = "tcp" | "uds";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/**
 * Strict security headers for every response served to the browser. The UI may only
 * talk to its own origin (HTTP + WebSocket on this port) and may only frame the panel
 * origin; a panel that navigates itself elsewhere is blocked by frame-src.
 */
export function securityHeaders(daemon: Pick<Daemon, "port" | "frameSources">): Record<string, string> {
  const ws = daemon.port ? `ws://127.0.0.1:${daemon.port} ws://localhost:${daemon.port}` : "";
  const frames = daemon.frameSources.length ? daemon.frameSources.join(" ") : "'none'";
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ${ws}; frame-src ${frames}; child-src ${frames}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  };
}

export function errorResponse(c: Context, err: unknown, status = 400) {
  if (err instanceof HarnessError) {
    const http = err.code === ErrorCode.PermissionDenied ? 403 : err.code === ErrorCode.MethodNotFound ? 404 : status;
    return c.json({ error: err.toJSON() }, http as 400);
  }
  return c.json({ error: { code: ErrorCode.InternalError, message: err instanceof Error ? err.message : String(err) } }, 500);
}

export function buildApp(daemon: Daemon, transport: Transport): Hono {
  const app = new Hono();
  const auth = daemon.auth;

  app.use("*", async (c, next) => {
    if (transport === "tcp") {
      if (!auth.isAllowedHost(c.req.header("host"))) return c.json({ error: { code: ErrorCode.PermissionDenied, message: "invalid Host header" } }, 403);
      if (!auth.isAllowedOrigin(c.req.header("origin"))) return c.json({ error: { code: ErrorCode.PermissionDenied, message: "cross-origin request rejected" } }, 403);
    }
    await next();
    for (const [k, v] of Object.entries(securityHeaders(daemon))) c.header(k, v);
  });

  // Authentication for the API surface.
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const bearer = auth.checkBearer(c.req.header("authorization"));
    const cookie = transport === "tcp" && auth.checkSessionCookie(c.req.header("cookie"));
    if (!bearer && !cookie) return c.json({ error: { code: ErrorCode.PermissionDenied, message: "unauthorized: run `harness open` to sign in" } }, 401);
    // Browsers must send a same-origin Origin on state-changing requests.
    if (transport === "tcp" && !bearer && c.req.method !== "GET" && !c.req.header("origin")) {
      return c.json({ error: { code: ErrorCode.PermissionDenied, message: "missing Origin header" } }, 403);
    }
    return next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, version: daemon.version, pid: process.pid }));
  app.get("/api/status", (c) => c.json(daemon.status()));

  // ---- providers, keys and model selection -------------------------------
  app.get("/api/providers", async (c) => {
    const list = await Promise.all(
      BUILTIN_PROVIDERS.map(async (p) => ({
        ...p,
        configured: !p.requiresKey || !!(await daemon.secrets.get(providerService(p.id), "apiKey")),
        baseURL: daemon.config.providers[p.id]?.baseURL ?? p.defaultBaseURL ?? null,
      })),
    );
    return c.json({ providers: list, current: daemon.config.model });
  });

  app.put("/api/providers/:id/key", async (c) => {
    const id = c.req.param("id");
    const info = getProviderInfo(id);
    if (!info) return errorResponse(c, new HarnessError(ErrorCode.InvalidParams, `未知的模型提供方：${id}`));
    const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string };
    const key = (body.apiKey ?? "").trim();
    if (key.length < 8) return errorResponse(c, new HarnessError(ErrorCode.InvalidParams, "API Key 格式不正确"));
    await daemon.secrets.set(providerService(id), "apiKey", key);
    daemon.audit.write({ kind: "secret.set", target: `provider:${id}`, decision: "info" });
    return c.json({ ok: true, provider: id, configured: true });
  });

  app.delete("/api/providers/:id/key", async (c) => {
    const id = c.req.param("id");
    const removed = await daemon.secrets.delete(providerService(id), "apiKey");
    daemon.audit.write({ kind: "secret.delete", target: `provider:${id}`, decision: "info" });
    return c.json({ ok: true, removed });
  });

  app.get("/api/config", (c) => c.json({ config: daemon.config }));

  app.put("/api/config/model", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { provider?: string; id?: string; baseURL?: string };
    if (!body.provider || !getProviderInfo(body.provider)) return errorResponse(c, new HarnessError(ErrorCode.InvalidParams, "provider 无效"));
    if (!body.id) return errorResponse(c, new HarnessError(ErrorCode.InvalidParams, "缺少模型 id"));
    daemon.updateConfig((cfg) => {
      cfg.model = { provider: body.provider as string, id: body.id as string };
      if (body.baseURL) cfg.providers[body.provider as string] = { ...(cfg.providers[body.provider as string] ?? {}), baseURL: body.baseURL };
    });
    return c.json({ ok: true, model: daemon.config.model });
  });

  app.patch("/api/config", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<{ approvals: Record<string, string>; maxSteps: number; workspace: string }>;
    daemon.updateConfig((cfg) => {
      if (body.approvals) {
        for (const k of ["read", "write", "exec", "network"] as const) {
          const v = body.approvals[k];
          if (v === "auto" || v === "ask") cfg.approvals[k] = v;
        }
      }
      if (typeof body.maxSteps === "number" && body.maxSteps >= 1 && body.maxSteps <= 50) cfg.agent.maxSteps = body.maxSteps;
      if (typeof body.workspace === "string") cfg.workspace = body.workspace;
    });
    return c.json({ ok: true, config: daemon.config });
  });

  // ---- sessions ------------------------------------------------------------
  app.get("/api/sessions", (c) => c.json({ sessions: daemon.sessions.list() }));

  app.post("/api/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; workspace?: string };
    const s = daemon.sessions.create(body.title ?? "新会话", body.workspace ?? daemon.config.workspace ?? null);
    return c.json({ session: s }, 201);
  });

  app.get("/api/sessions/:id", (c) => {
    const s = daemon.sessions.get(c.req.param("id"));
    if (!s) return c.json({ error: { code: ErrorCode.InvalidParams, message: "会话不存在" } }, 404);
    const messages = daemon.sessions.messages(s.id).map((m) => ({ id: m.id, seq: m.seq, role: m.role, content: JSON.parse(m.content), createdAt: m.created_at }));
    return c.json({ session: s, messages, running: daemon.runtime.isRunning(s.id) });
  });

  app.delete("/api/sessions/:id", (c) => {
    daemon.sessions.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/cancel", (c) => c.json({ ok: daemon.runtime.cancel(c.req.param("id")) }));

  /**
   * Sends a user message. With `Accept: application/x-ndjson` the response
   * streams every event of the turn (used by the CLI); otherwise it returns 202
   * and events arrive over the WebSocket (used by the Web UI).
   */
  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = (body.text ?? "").trim();
    if (!text) return errorResponse(c, new HarnessError(ErrorCode.InvalidParams, "消息不能为空"));
    if (!daemon.sessions.get(id)) return c.json({ error: { code: ErrorCode.InvalidParams, message: "会话不存在" } }, 404);
    if ((c.req.header("accept") ?? "").includes("application/x-ndjson")) {
      const encoder = new TextEncoder();
      let off: () => void = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          off = daemon.bus.on((e: HostEvent) => {
            if ("sessionId" in e && e.sessionId === id) {
              try {
                controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
              } catch {
                // client went away; the turn keeps running and is persisted
              }
            }
          });
          void daemon.chat(id, text).finally(() => {
            off();
            try {
              controller.close();
            } catch {
              // already closed
            }
          });
        },
        cancel() {
          off();
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
    }
    void daemon.chat(id, text);
    return c.json({ ok: true, accepted: true }, 202);
  });

  app.post("/api/approvals/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { approved?: boolean };
    const ok = daemon.approvals.resolve(c.req.param("id"), body.approved === true);
    return c.json({ ok }, ok ? 200 : 404);
  });

  app.get("/api/audit", (c) => {
    const pluginId = c.req.query("plugin") ?? undefined;
    const decision = c.req.query("decision") ?? undefined;
    return c.json({ events: daemon.audit.list({ pluginId, decision, limit: Number(c.req.query("limit") ?? 200) }) });
  });

  app.get("/api/tool-calls", (c) => c.json({ calls: daemon.toolCalls.recent(c.req.query("plugin") ?? null, Number(c.req.query("limit") ?? 50)) }));

  // ---- extension routes registered by subsystems (plugins, panels, ...) ----
  for (const register of daemon.routeRegistrars) register(app, transport);

  // ---- CLI-only control endpoints (Unix socket) ----------------------------
  if (transport === "uds") {
    app.post("/api/auth/login-link", (c) => {
      const code = auth.mintLoginCode();
      return c.json({ url: `http://127.0.0.1:${daemon.port}/auth/callback?code=${encodeURIComponent(code)}` });
    });
    app.post("/api/auth/revoke-web-sessions", (c) => {
      auth.revokeAllWebSessions();
      return c.json({ ok: true });
    });
    app.post("/api/daemon/shutdown", (c) => {
      setTimeout(() => void daemon.stop().then(() => process.exit(0)), 50);
      return c.json({ ok: true });
    });
  }

  // ---- browser login + static Web UI ---------------------------------------
  if (transport === "tcp") {
    app.get("/auth/callback", (c) => {
      const session = auth.redeemLoginCode(c.req.query("code") ?? "");
      if (!session) return c.html("<!doctype html><meta charset=utf-8><p>登录链接无效或已过期。请在终端重新运行 <code>harness open</code>。</p>", 401);
      c.header("Set-Cookie", auth.cookieHeader(session));
      return c.redirect("/", 302);
    });
    app.get("*", (c) => serveStatic(c, daemon.webDist));
  }

  app.onError((err, c) => errorResponse(c, err, 500));
  return app;
}

function serveStatic(c: Context, root: string | null) {
  if (!root || !existsSync(root)) {
    return c.html(
      "<!doctype html><meta charset=utf-8><title>Harness</title><body style='font-family:-apple-system;padding:40px'><h2>Harness 正在运行</h2><p>Web 界面尚未构建。请在仓库根目录运行 <code>pnpm build:web</code>。</p></body>",
    );
  }
  const rel = normalize(decodeURIComponent(c.req.path)).replace(/^(\.\.(\/|\\|$))+/, "");
  let file = resolve(join(root, rel));
  if (!file.startsWith(resolve(root))) return c.text("forbidden", 403);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const body = readFileSync(file);
  const cache = file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return c.body(body, 200, { "content-type": type, "cache-control": cache });
}
