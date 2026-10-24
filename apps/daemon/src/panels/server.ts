import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { Daemon, Subsystem } from "../daemon.ts";
import type { PluginManager } from "../plugins/manager.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function within(file: string, base: string): boolean {
  return file === base || file.startsWith(base.endsWith(sep) ? base : base + sep);
}

export interface PanelServerOptions {
  /** Port for the panel origin; default: main port + 1 when free, else a random port. */
  port?: number;
}

/**
 * Serves plugin UI panels from their own origin (report 3.16).
 *
 * The panel origin differs from the host UI origin, so a panel can never read the UI's
 * cookies, DOM or API. Every document is served with a CSP that (a) blocks all network
 * access (`connect-src 'none'`), (b) sandboxes the document even when opened directly in
 * a tab (`sandbox allow-scripts allow-forms`, no allow-same-origin => opaque origin), and
 * (c) can only be framed by the host UI (`frame-ancestors`). Only panels that an enabled,
 * healthy plugin declares in its manifest are served, and only files inside the panel's
 * directory (symlinks are resolved before the check).
 */
export class PanelServer implements Subsystem {
  readonly name = "panels";
  port = 0;
  private server: Server | null = null;
  private readonly daemon: Daemon;
  private readonly pm: PluginManager;
  private readonly opts: PanelServerOptions;

  constructor(daemon: Daemon, pm: PluginManager, opts: PanelServerOptions = {}) {
    this.daemon = daemon;
    this.pm = pm;
    this.opts = opts;
  }

  get origin(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  /** Origins the host UI may load frames from (used for the UI's CSP frame-src). */
  frameSources(): string[] {
    return this.port ? [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`] : [];
  }

  urlFor(pluginId: string, panelId: string): string | null {
    return this.origin ? `${this.origin}/${encodeURIComponent(pluginId)}/${encodeURIComponent(panelId)}/` : null;
  }

  private allowedHost(host: string | undefined): boolean {
    const h = (host ?? "").toLowerCase();
    return h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}`;
  }

  csp(): string {
    const self = this.frameSources().join(" ");
    const main = this.daemon.port ? [`http://127.0.0.1:${this.daemon.port}`, `http://localhost:${this.daemon.port}`] : [];
    // `pnpm --filter @harness/web dev` serves the UI from Vite; opt-in only, loopback only.
    const dev = (this.daemon.env.HARNESS_UI_DEV_ORIGIN ?? "").split(",").filter((o) => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o));
    const ancestors = [...main, ...dev].join(" ") || "'none'";
    return [
      "default-src 'none'",
      `script-src ${self} 'unsafe-inline'`,
      `style-src ${self} 'unsafe-inline'`,
      `img-src ${self} data: blob:`,
      `font-src ${self} data:`,
      `media-src ${self} data: blob:`,
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "object-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${ancestors}`,
      "sandbox allow-scripts allow-forms",
    ].join("; ");
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    const preferred = this.opts.port ?? (this.daemon.port ? this.daemon.port + 1 : 0);
    this.port = await new Promise<number>((resolveP, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && preferred !== 0) {
          server.removeListener("error", onError);
          server.listen(0, "127.0.0.1", () => resolveP((server.address() as AddressInfo).port));
        } else reject(err);
      };
      server.once("error", onError);
      server.listen(preferred, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolveP((server.address() as AddressInfo).port);
      });
    });
    this.daemon.frameSources = this.frameSources();
    this.daemon.logger.info({ origin: this.origin }, "panel server listening");
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    this.daemon.frameSources = [];
    if (!srv) return;
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
  }

  status() {
    return { origin: this.origin, panels: this.pm.panels().length };
  }

  private send(res: ServerResponse, code: number, text: string, extra: Record<string, string> = {}): void {
    res.writeHead(code, {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "cache-control": "no-store",
      ...extra,
    });
    res.end(text);
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    if (!this.allowedHost(req.headers.host)) return this.send(res, 403, "invalid Host header");
    if (req.method !== "GET" && req.method !== "HEAD") return this.send(res, 405, "method not allowed", { allow: "GET, HEAD" });
    let parts: string[];
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://panel.invalid").pathname;
      parts = pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    } catch {
      return this.send(res, 400, "bad request");
    }
    if (parts.some((s) => s === ".." || s === "." || s.includes("\0") || s.includes("/") || s.includes("\\"))) return this.send(res, 403, "forbidden");
    const [pluginId, panelId, ...rest] = parts;
    if (!pluginId || !panelId) return this.send(res, 404, "not found");
    const found = this.pm.panelFor(pluginId, panelId);
    if (!found) return this.send(res, 404, "面板不存在，或插件没有启用");
    if (!rest.length && !pathname.endsWith("/")) {
      res.writeHead(308, { location: `/${encodeURIComponent(pluginId)}/${encodeURIComponent(panelId)}/`, "cache-control": "no-store" });
      return void res.end();
    }
    const entry = resolve(found.plugin.dir, found.panel.entry);
    let base: string;
    try {
      base = realpathSync(dirname(entry));
    } catch {
      return this.send(res, 404, "面板入口不存在（插件可能还没有构建）");
    }
    const target = resolve(base, rest.length ? rest.join("/") : basename(entry));
    if (!within(target, base)) return this.send(res, 403, "forbidden");
    if (!existsSync(target)) return this.send(res, 404, rest.length ? "not found" : "面板入口不存在（插件可能还没有构建）");
    let real: string;
    try {
      real = realpathSync(target);
    } catch {
      return this.send(res, 404, "not found");
    }
    if (!within(real, base) || statSync(real).isDirectory()) return this.send(res, 403, "forbidden");
    const headers: Record<string, string> = {
      "content-type": MIME[extname(real).toLowerCase()] ?? "application/octet-stream",
      "content-security-policy": this.csp(),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=()",
      "cache-control": "no-cache",
    };
    // Sandboxed documents have an opaque origin and send `Origin: null` for module scripts.
    if (req.headers.origin === "null") headers["access-control-allow-origin"] = "null";
    const body = readFileSync(join(real));
    res.writeHead(200, { ...headers, "content-length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
  }
}
