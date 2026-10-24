import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createLogger, ensureLayout, resolvePaths, type HarnessPaths, type Logger } from "@harness/shared";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentRuntime } from "./agent/runtime.ts";
import { ApprovalBroker, noopHooks, ToolRegistry, type HookRunner } from "./agent/tools.ts";
import { AuthService } from "./api/security.ts";
import { buildApp, type Transport } from "./api/routes.ts";
import { loadConfig, saveConfig, type HarnessConfig } from "./config.ts";
import { EventBus } from "./events/bus.ts";
import { createLanguageModel } from "./models/providers.ts";
import { createSecretStore, type SecretStore } from "./secrets/store.ts";
import { openDatabase, type Db } from "./store/db.ts";
import { AuditRepo, SessionRepo, ToolCallRepo } from "./store/repos.ts";

export const VERSION = "0.1.0";
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  /** TCP port; 0 picks a free one. Defaults to config.server.port, falling back to a free port. */
  port?: number;
  secrets?: SecretStore;
  /** Overrides model construction (tests). */
  modelFactory?: () => Promise<LanguageModelV4>;
  webDist?: string | null;
  logToStderr?: boolean;
}

export type RouteRegistrar = (app: Hono, transport: Transport) => void;

/** Subsystems that start after the API is up and stop before it goes down (plugin manager, panels). */
export interface Subsystem {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  status?(): unknown;
}

export class Daemon {
  readonly version = VERSION;
  readonly paths: HarnessPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly db: Db;
  readonly sessions: SessionRepo;
  readonly toolCalls: ToolCallRepo;
  readonly audit: AuditRepo;
  readonly secrets: SecretStore;
  readonly bus = new EventBus();
  readonly tools = new ToolRegistry();
  readonly approvals: ApprovalBroker;
  readonly auth: AuthService;
  readonly runtime: AgentRuntime;
  readonly routeRegistrars: RouteRegistrar[] = [];
  readonly subsystems: Subsystem[] = [];
  readonly webDist: string | null;
  hooks: HookRunner = noopHooks;
  port = 0;
  /** Origins the UI may frame (set by the panel server); everything else is blocked by CSP. */
  frameSources: string[] = [];
  readonly startedAt = Date.now();

  private cfg: HarnessConfig;
  private readonly opts: DaemonOptions;
  private tcp: Server | null = null;
  private uds: Server | null = null;
  private wss: WebSocketServer | null = null;
  private stopping: Promise<void> | null = null;

  constructor(opts: DaemonOptions = {}) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.paths = resolvePaths(this.env);
    ensureLayout(this.paths);
    this.logger = createLogger({ name: "harnessd", file: opts.logToStderr ? undefined : `${this.paths.logsDir}/harnessd.log` });
    this.db = openDatabase(this.paths.dbFile);
    this.sessions = new SessionRepo(this.db);
    this.toolCalls = new ToolCallRepo(this.db);
    this.audit = new AuditRepo(this.db);
    this.secrets = opts.secrets ?? createSecretStore(this.env);
    this.cfg = loadConfig(this.paths.configFile);
    this.approvals = new ApprovalBroker(this.bus);
    this.auth = new AuthService(this.db);
    this.webDist = opts.webDist === undefined ? resolve(REPO_ROOT, "apps", "web", "dist") : opts.webDist;
    this.runtime = new AgentRuntime({
      sessions: this.sessions,
      toolCalls: this.toolCalls,
      tools: this.tools,
      hooks: { run: (event, payload, meta) => this.hooks.run(event, payload, meta) },
      approvals: this.approvals,
      getConfig: () => this.cfg,
      getModel: () => this.getModel(),
    });
  }

  /** The model currently selected in config (or the test override). */
  getModel(): Promise<LanguageModelV4> {
    return this.opts.modelFactory ? this.opts.modelFactory() : createLanguageModel(this.cfg, this.secrets);
  }

  get config(): HarnessConfig {
    return this.cfg;
  }

  updateConfig(mutate: (cfg: HarnessConfig) => void): HarnessConfig {
    const next = structuredClone(this.cfg);
    mutate(next);
    saveConfig(this.paths.configFile, next);
    this.cfg = next;
    return next;
  }

  reloadConfig(): void {
    this.cfg = loadConfig(this.paths.configFile);
  }

  chat(sessionId: string, text: string) {
    return this.runtime.runTurn(sessionId, text, { emit: (e) => this.bus.emit(e) });
  }

  status() {
    return {
      version: this.version,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      port: this.port,
      socketPath: this.paths.socketPath,
      home: this.paths.dataDir,
      model: this.cfg.model,
      secretsBackend: this.secrets.kind,
      tools: this.tools.list().map((t) => ({ name: t.name, pluginId: t.pluginId, risk: t.risk })),
      subsystems: Object.fromEntries(this.subsystems.map((s) => [s.name, s.status?.() ?? "ok"])),
    };
  }

  private listenTcp(port: number): Promise<number> {
    const listener = getRequestListener(buildApp(this, "tcp").fetch);
    const server = createServer(listener);
    this.tcp = server;
    this.attachWebSocket(server);
    return new Promise((resolveP, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port !== 0) {
          server.removeListener("error", onError);
          server.listen(0, "127.0.0.1", () => resolveP((server.address() as AddressInfo).port));
        } else reject(err);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolveP((server.address() as AddressInfo).port);
      });
    });
  }

  private listenUds(): Promise<void> {
    const sock = this.paths.socketPath;
    mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
    if (existsSync(sock)) unlinkSync(sock);
    const server = createServer(getRequestListener(buildApp(this, "uds").fetch));
    this.uds = server;
    return new Promise((resolveP, reject) => {
      server.once("error", reject);
      server.listen(sock, () => {
        chmodSync(sock, 0o600);
        resolveP();
      });
    });
  }

  private attachWebSocket(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const reject = (code: number) => {
        socket.write(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        return reject(400);
      }
      if (url.pathname !== "/api/events") return reject(404);
      if (!this.auth.isAllowedHost(req.headers.host)) return reject(403);
      if (!this.auth.isAllowedOrigin(req.headers.origin)) return reject(403);
      const ok = this.auth.checkBearer(req.headers.authorization) || this.auth.checkSessionCookie(req.headers.cookie);
      if (!ok) return reject(401);
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const off = this.bus.on((e) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
        });
        const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25_000);
        ws.on("close", () => {
          off();
          clearInterval(ping);
        });
        ws.send(JSON.stringify({ type: "hello", version: this.version }));
      });
    });
  }

  async start(): Promise<{ port: number; socketPath: string; token: string }> {
    const port = this.opts.port ?? Number(this.env.HARNESS_PORT ?? this.cfg.server.port);
    this.port = await this.listenTcp(port);
    this.auth.setPort(this.port);
    await this.listenUds();
    for (const s of this.subsystems) {
      try {
        await s.start();
      } catch (err) {
        this.logger.error({ err, subsystem: s.name }, "subsystem failed to start");
      }
    }
    writeFileSync(
      this.paths.daemonInfoFile,
      JSON.stringify({ pid: process.pid, version: this.version, port: this.port, socketPath: this.paths.socketPath, token: this.auth.token, startedAt: new Date(this.startedAt).toISOString() }, null, 2),
      { mode: 0o600 },
    );
    this.logger.info({ port: this.port, socket: this.paths.socketPath }, "harnessd started");
    return { port: this.port, socketPath: this.paths.socketPath, token: this.auth.token };
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      for (const s of [...this.subsystems].reverse()) {
        try {
          await s.stop();
        } catch (err) {
          this.logger.error({ err, subsystem: s.name }, "subsystem failed to stop");
        }
      }
      for (const client of this.wss?.clients ?? []) client.terminate();
      await Promise.all(
        [this.tcp, this.uds].map(
          (srv) =>
            new Promise<void>((r) => {
              if (!srv) return r();
              srv.closeAllConnections?.();
              srv.close(() => r());
            }),
        ),
      );
      for (const f of [this.paths.daemonInfoFile, this.paths.socketPath]) {
        try {
          unlinkSync(f);
        } catch {
          // already gone
        }
      }
      try {
        this.db.close();
      } catch {
        // already closed
      }
      this.logger.info("harnessd stopped");
      this.logger.flush?.();
    })();
    return this.stopping;
  }
}
