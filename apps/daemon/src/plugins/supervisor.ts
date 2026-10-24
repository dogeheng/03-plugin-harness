import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { Manifest } from "@harness/manifest";
import {
  type InitializeParams,
  type InitializeResult,
  type JsonRpcMessage,
  Methods,
  ndjsonTransport,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
  RpcErrorName,
  RpcPeer,
} from "@harness/protocol";
import { nowIso, redact, redactDeep, sleep, type PluginState } from "@harness/shared";
import type { EventBus } from "../events/bus.ts";
import type { LaunchSpec } from "./launcher.ts";

export interface PluginFailure {
  phase: "activate" | "handshake" | "call" | "runtime" | "heartbeat" | "hook";
  code: number;
  codeName: string;
  message: string;
  action: string;
  suggestion?: string;
  at: string;
  detail?: string[];
}

export interface InstanceSnapshot {
  state: PluginState;
  pid: number | null;
  startedAt: string | null;
  lastError: PluginFailure | null;
  crashes: number;
  stats: { calls: number; errors: number; timeouts: number; totalMs: number; activations: number; lastCallAt: string | null };
  registrations: InitializeResult["registrations"] | null;
  sdk: string | null;
  isolation: string[];
  sandboxed: boolean;
  inflight: number;
}

export interface CallOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  workspace?: string | null;
}

/** What the manager talks to; implemented by process plugins and (M3) WASM plugins. */
export interface PluginInstance {
  readonly pluginId: string;
  readonly state: PluginState;
  call<T = unknown>(method: string, params: unknown, opts: CallOptions): Promise<T>;
  notify(method: string, params: unknown): void;
  ensureActive(): Promise<void>;
  stop(next: "idle" | "disabled" | "stopped"): Promise<void>;
  restart(): Promise<void>;
  /** Workspaces of the calls currently in flight (used to scope ${workspace}). */
  activeWorkspaces(): Array<string | null>;
  snapshot(): InstanceSnapshot;
  traces(): TraceEntry[];
  resetFailures(): void;
}

export interface TraceEntry {
  ts: string;
  direction: "in" | "out";
  message: unknown;
}

export interface SupervisorTiming {
  handshakeMs: number;
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  heartbeatMisses: number;
  idleMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  crashWindowMs: number;
  crashLimit: number;
  stopGraceMs: number;
  consecutiveTimeoutLimit: number;
}

export const DEFAULT_TIMING: SupervisorTiming = {
  handshakeMs: 10_000,
  heartbeatMs: 15_000,
  heartbeatTimeoutMs: 5_000,
  heartbeatMisses: 3,
  idleMs: 10 * 60_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  crashWindowMs: 10 * 60_000,
  crashLimit: 5,
  stopGraceMs: 5_000,
  consecutiveTimeoutLimit: 3,
};

export interface SupervisorDeps {
  pluginId: string;
  version: string;
  manifest: Manifest;
  bus: EventBus;
  logFile: string;
  launch(): LaunchSpec | Promise<LaunchSpec>;
  initParams(): Omit<InitializeParams, "protocolVersions" | "host">;
  hostInfo: { name: string; version: string };
  registerHost(peer: RpcPeer, instance: PluginInstance): void;
  onQuarantine(reason: string): void;
  /** Whether the instance should be kept warm (hooks) and restarted eagerly after a crash. */
  keepAlive(): boolean;
  traceEnabled(): boolean;
  timing?: Partial<SupervisorTiming>;
}

const LOG_LINES_PER_SEC = 200;

function short(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Turns a process exit + stderr tail into a sentence a user can act on. */
export function explainExit(tail: string, code: number | null, signal: NodeJS.Signals | null, memoryMb: number): { message: string; suggestion: string } {
  if (/heap limit|out of memory|Allocation failed/i.test(tail))
    return { message: `插件内存超过上限（${memoryMb}MB），已被结束`, suggestion: "检查插件是否有内存泄漏，或在清单 limits.memoryMb 中声明更合理的上限" };
  if (/ERR_ACCESS_DENIED/.test(tail)) {
    const res = /resource: '([^']+)'/.exec(tail)?.[1];
    return { message: `插件尝试绕过宿主直接访问${res ? ` ${res}` : "文件或子进程"}，被 Node 权限模型拒绝后退出`, suggestion: "插件应通过 ctx.host.fs / ctx.host.process 等宿主 API 访问资源" };
  }
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(tail)) return { message: "插件入口或依赖文件缺失", suggestion: "重新构建插件（pnpm build），确认依赖已打包进入口文件" };
  if (/SyntaxError/.test(tail)) return { message: "插件代码有语法错误，无法加载", suggestion: "查看插件日志中的错误位置" };
  const thrown = /(?:^|\n)\s*((?:[A-Z]\w*)?Error(?:\s*\[[^\]]*\])?:[^\n]*)/.exec(tail)?.[1]?.trim();
  if (code === 70 || /uncaught exception/i.test(tail) || (code === 1 && thrown && /\n\s+at\s/.test(tail)))
    return { message: `插件抛出了未捕获的异常并退出${thrown ? `：${thrown.slice(0, 200)}` : ""}`, suggestion: "查看插件日志（harness plugin logs）中的堆栈；异步代码请用 try/catch 或 .catch() 处理错误" };
  if (signal === "SIGKILL") return { message: "插件进程被强制结束（SIGKILL）", suggestion: "查看插件日志（harness plugin logs）" };
  return { message: `插件进程意外退出（退出码 ${code ?? "无"}${signal ? `，信号 ${signal}` : ""}）`, suggestion: "查看插件日志（harness plugin logs）" };
}

export class ProcessSupervisor implements PluginInstance {
  readonly pluginId: string;
  private readonly d: SupervisorDeps;
  private readonly t: SupervisorTiming;
  private _state: PluginState = "enabled";
  private child: ChildProcess | null = null;
  private peer: RpcPeer | null = null;
  private activating: Promise<RpcPeer> | null = null;
  private stopping = false;
  private crashTimes: number[] = [];
  private nextStartAt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private misses = 0;
  private consecutiveTimeouts = 0;
  /** Set when the host kills the process itself, so the exit keeps the real cause. */
  private killedFor: PluginFailure | null = null;
  private lastError: PluginFailure | null = null;
  private startedAt: string | null = null;
  private registrations: InitializeResult["registrations"] | null = null;
  private sdk: string | null = null;
  private isolation: string[] = [];
  private stopGen = 0;
  private sandboxed = false;
  private stderrTail: string[] = [];
  private readonly trace: TraceEntry[] = [];
  private readonly inflight = new Map<number, string | null>();
  private callSeq = 0;
  private logWindow = { start: 0, count: 0, dropped: 0 };
  private readonly stats = { calls: 0, errors: 0, timeouts: 0, totalMs: 0, activations: 0, lastCallAt: null as string | null };

  constructor(deps: SupervisorDeps) {
    this.d = deps;
    this.pluginId = deps.pluginId;
    this.t = { ...DEFAULT_TIMING, ...deps.timing };
  }

  get state(): PluginState {
    return this._state;
  }

  private setState(s: PluginState, detail?: string): void {
    if (this._state === s && !detail) return;
    this._state = s;
    this.d.bus.emit({ type: "plugin.state", pluginId: this.pluginId, state: s, detail });
  }

  private writeLog(level: string, message: string): void {
    const now = Date.now();
    if (now - this.logWindow.start >= 1000) {
      if (this.logWindow.dropped) appendFileSync(this.d.logFile, `${nowIso()} warn [harness] dropped ${this.logWindow.dropped} log lines (rate limit ${LOG_LINES_PER_SEC}/s)\n`);
      this.logWindow = { start: now, count: 0, dropped: 0 };
    }
    if (++this.logWindow.count > LOG_LINES_PER_SEC) {
      this.logWindow.dropped++;
      return;
    }
    const clean = redact(message);
    try {
      appendFileSync(this.d.logFile, `${nowIso()} ${level} ${clean}\n`, { mode: 0o600 });
    } catch {
      // log dir missing; ignore
    }
    this.d.bus.emit({ type: "plugin.log", pluginId: this.pluginId, level, message: short(clean, 2000), ts: nowIso() });
  }

  log(level: string, message: string, data?: unknown): void {
    this.writeLog(level, data === undefined ? message : `${message} ${JSON.stringify(redactDeep(data))}`);
  }

  private recordTrace(direction: "in" | "out", message: JsonRpcMessage): void {
    const entry = { ts: nowIso(), direction, message: redactDeep(message) };
    this.trace.push(entry);
    if (this.trace.length > 300) this.trace.shift();
    if (this.d.traceEnabled()) this.d.bus.emit({ type: "hpp.trace", pluginId: this.pluginId, direction, message: entry.message, ts: entry.ts });
  }

  private fail(f: Omit<PluginFailure, "at" | "codeName">): PluginFailure {
    const failure: PluginFailure = { ...f, codeName: RpcErrorName[f.code] ?? "Error", at: nowIso(), detail: f.detail ?? this.stderrTail.slice(-8) };
    this.lastError = failure;
    this.d.bus.emit({
      type: "plugin.error",
      pluginId: this.pluginId,
      phase: failure.phase,
      error: { code: failure.code, name: failure.codeName, message: failure.message },
      action: failure.action,
      suggestion: failure.suggestion,
    });
    this.writeLog("error", `[harness] ${failure.phase}: ${failure.message} → ${failure.action}`);
    return failure;
  }

  /** Records a crash and decides between backoff and quarantine. Returns true when quarantined. */
  private countCrash(): boolean {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.t.crashWindowMs);
    this.crashTimes.push(now);
    const n = this.crashTimes.length;
    if (n >= this.t.crashLimit) {
      const reason = `${Math.round(this.t.crashWindowMs / 60_000)} 分钟内失败 ${n} 次`;
      this.setState("quarantined", reason);
      this.d.onQuarantine(reason);
      return true;
    }
    const backoff = Math.min(this.t.backoffBaseMs * 2 ** (n - 1), this.t.backoffMaxMs);
    this.nextStartAt = now + backoff;
    this.setState("failed", `将在 ${Math.round(backoff / 1000)} 秒后可重启（第 ${n} 次失败）`);
    if (this.d.keepAlive()) {
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => void this.ensureActive().catch(() => {}), backoff);
    }
    return false;
  }

  activeWorkspaces(): Array<string | null> {
    return [...new Set(this.inflight.values())];
  }

  async ensureActive(): Promise<void> {
    await this.getPeer();
  }

  private async getPeer(): Promise<RpcPeer> {
    if (this._state === "quarantined") throw new RpcError(RpcErrorCode.NotActive, `插件已被隔离：${this.lastError?.message ?? "多次失败"}。修复后运行 harness plugin enable ${this.pluginId} 恢复`);
    if (this._state === "disabled") throw new RpcError(RpcErrorCode.NotActive, "插件已禁用");
    if (this.peer && !this.peer.closed && this._state === "active") return this.peer;
    if (!this.activating) {
      this.activating = this.activate().finally(() => {
        this.activating = null;
      });
    }
    return this.activating;
  }

  private async activate(): Promise<RpcPeer> {
    // stop() bumps stopGen; an activation that outlives a stop must not spawn anything.
    const gen = this.stopGen;
    const abandoned = () => new RpcError(RpcErrorCode.NotActive, "插件在启动过程中被停止");
    const wait = this.nextStartAt - Date.now();
    if (wait > 0) await sleep(Math.min(wait, this.t.backoffMaxMs));
    if (gen !== this.stopGen) throw abandoned();
    this.setState("activating");
    this.stopping = false;
    this.stats.activations++;
    let spec: LaunchSpec;
    try {
      spec = await this.d.launch();
      if (gen !== this.stopGen) throw abandoned();
    } catch (e) {
      if (gen !== this.stopGen) throw abandoned();
      const f = this.fail({ phase: "activate", code: RpcErrorCode.NotActive, message: `无法启动插件：${(e as Error).message}`, action: "未启动", suggestion: "检查插件文件是否完整，或重新安装" });
      this.countCrash();
      throw new RpcError(f.code, f.message);
    }
    this.isolation = spec.isolation;
    this.sandboxed = spec.sandboxed;
    this.stderrTail = [];
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const peer = new RpcPeer(ndjsonTransport(child.stdout as NodeJS.ReadableStream, child.stdin as NodeJS.WritableStream), {
      trace: (dir, msg) => this.recordTrace(dir, msg),
      onInvalidLine: (line) => this.writeLog("warn", `[stdout 非协议输出，已忽略] ${short(line, 300)}（请改用 ctx.log 或 console.error）`),
      maxConcurrentIncoming: 32,
    });
    this.peer = peer;
    this.d.registerHost(peer, this);
    let stderrBuf = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      stderrBuf += c;
      let i = stderrBuf.indexOf("\n");
      while (i >= 0) {
        const line = stderrBuf.slice(0, i);
        stderrBuf = stderrBuf.slice(i + 1);
        this.stderrTail.push(redact(short(line, 500)));
        if (this.stderrTail.length > 50) this.stderrTail.shift();
        this.writeLog("stderr", line);
        i = stderrBuf.indexOf("\n");
      }
    });
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
      // "close" fires after stdio has drained, so the exit explanation sees all of stderr.
      child.once("close", (code, signal) => {
        exitInfo = { code, signal };
        r(exitInfo);
      }),
    );
    child.once("error", (e) => this.writeLog("error", `[harness] spawn error: ${e.message}`));
    void exited.then((x) => this.handleExit(child, x.code, x.signal));

    try {
      const params = this.d.initParams();
      const init = await Promise.race([
        peer.request<InitializeResult>(Methods.initialize, { protocolVersions: [PROTOCOL_VERSION], host: this.d.hostInfo, ...params } satisfies InitializeParams, { timeoutMs: this.t.handshakeMs }),
        exited.then(() => {
          throw new RpcError(RpcErrorCode.NotActive, "插件进程在握手完成前退出");
        }),
      ]);
      if (init.protocolVersion !== PROTOCOL_VERSION) throw new RpcError(RpcErrorCode.IncompatibleProtocol, `插件选择了不支持的协议版本 ${init.protocolVersion}`);
      this.checkRegistrations(init.registrations ?? {});
      this.registrations = init.registrations ?? {};
      this.sdk = init.plugin?.sdk ?? null;
      peer.notify(Methods.initialized, {});
    } catch (err) {
      const e = err as RpcError;
      const code = typeof e.code === "number" ? e.code : RpcErrorCode.NotActive;
      this.stopping = true;
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(1000)]);
      this.peer = null;
      this.child = null;
      if (code === RpcErrorCode.IncompatibleProtocol) {
        this.fail({ phase: "handshake", code, message: e.message, action: "已标记为不兼容，不会自动重启", suggestion: "安装与当前 Harness 兼容的插件版本" });
        this.setState("incompatible", e.message);
        throw new RpcError(code, e.message);
      }
      const timeout = code === RpcErrorCode.Timeout;
      // Let stderr drain so the explanation can use it.
      await sleep(30);
      const died = exitInfo as { code: number | null; signal: NodeJS.Signals | null } | null;
      const why = died && !timeout && code !== RpcErrorCode.InvalidRegistration ? explainExit(this.stderrTail.join("\n"), died.code, died.signal, this.d.manifest.limits?.memoryMb ?? 256) : null;
      const f = this.fail({
        phase: "handshake",
        code,
        message: timeout ? `插件在 ${this.t.handshakeMs / 1000} 秒内没有完成握手` : code === RpcErrorCode.InvalidRegistration ? e.message : why ? `激活失败：${why.message}` : `激活失败：${e.message}`,
        action: "已结束插件进程",
        suggestion: timeout ? "检查插件入口是否调用了 definePlugin()/plugin.run()，或查看插件日志" : (why?.suggestion ?? "查看插件日志（harness plugin logs）"),
      });
      this.countCrash();
      throw new RpcError(f.code, f.message);
    }
    this.startedAt = nowIso();
    this.misses = 0;
    this.consecutiveTimeouts = 0;
    this.setState("active");
    this.startHeartbeat();
    this.touchIdle();
    return peer;
  }

  private checkRegistrations(r: InitializeResult["registrations"]): void {
    const c = this.d.manifest.contributes ?? {};
    const declared = {
      tools: new Set((c.tools ?? []).map((t) => t.name)),
      commands: new Set((c.commands ?? []).map((t) => t.name)),
      hooks: new Set((c.hooks ?? []).map((t) => t.event)),
    };
    const extra: string[] = [];
    for (const t of r.tools ?? []) if (!declared.tools.has(t.name)) extra.push(`工具 ${t.name}`);
    for (const t of r.commands ?? []) if (!declared.commands.has(t.name)) extra.push(`命令 ${t.name}`);
    for (const t of r.hooks ?? []) if (!declared.hooks.has(t.event as never)) extra.push(`钩子 ${t.event}`);
    if (extra.length) throw new RpcError(RpcErrorCode.InvalidRegistration, `插件注册了清单中没有声明的能力：${extra.join("、")}。所有能力必须先在 harness.plugin.json 中声明`);
    const registered = new Set((r.tools ?? []).map((t) => t.name));
    for (const name of declared.tools) if (!registered.has(name)) this.writeLog("warn", `[harness] 清单声明了工具 ${name}，但插件没有实现它`);
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (child !== this.child) return;
    this.stopHeartbeat();
    this.child = null;
    const peer = this.peer;
    this.peer = null;
    peer?.close("process exited");
    if (this.stopping) return;
    const killedFor = this.killedFor;
    this.killedFor = null;
    if (!killedFor) {
      const { message, suggestion } = explainExit(this.stderrTail.join("\n"), code, signal, this.d.manifest.limits?.memoryMb ?? 256);
      this.fail({ phase: "runtime", code: RpcErrorCode.NotActive, message, action: "将按退避策略重启", suggestion });
    }
    this.countCrash();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      const peer = this.peer;
      if (!peer || peer.closed) return;
      peer.request(Methods.ping, {}, { timeoutMs: this.t.heartbeatTimeoutMs }).then(
        () => {
          this.misses = 0;
        },
        () => {
          this.misses++;
          if (this.misses >= this.t.heartbeatMisses) {
            this.killedFor = this.fail({ phase: "heartbeat", code: RpcErrorCode.Timeout, message: `连续 ${this.misses} 次心跳没有响应，插件可能卡死（例如死循环）`, action: "已强制结束插件进程，将按退避策略重启", suggestion: "检查插件中是否有阻塞事件循环的同步代码" });
            this.misses = 0;
            this.child?.kill("SIGKILL");
          }
        },
      );
    }, this.t.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.inflight.size === 0 && !this.d.keepAlive() && this._state === "active") void this.stop("idle");
      else this.touchIdle();
    }, this.t.idleMs);
    this.idleTimer.unref?.();
  }

  async call<T = unknown>(method: string, params: unknown, opts: CallOptions): Promise<T> {
    const peer = await this.getPeer();
    const child = this.child;
    const seq = ++this.callSeq;
    this.inflight.set(seq, opts.workspace ?? null);
    const started = Date.now();
    this.stats.calls++;
    this.stats.lastCallAt = nowIso();
    try {
      const out = await peer.request<T>(method, params, { timeoutMs: opts.timeoutMs, signal: opts.signal });
      this.consecutiveTimeouts = 0;
      return out;
    } catch (err) {
      this.stats.errors++;
      const e = err as RpcError;
      if (peer.closed && e?.code !== RpcErrorCode.Timeout && e?.code !== RpcErrorCode.Cancelled && !this.stopping) {
        // The process died while handling this request: wait for the exit handler so we can say why.
        for (let i = 0; i < 25 && this.child === child && child; i++) await sleep(20);
        const why = this.lastError?.phase === "runtime" || this.lastError?.phase === "heartbeat" ? this.lastError.message : "插件进程在处理请求时退出";
        throw new RpcError(RpcErrorCode.NotActive, `${why}（本次调用失败；插件会自动重启）`, { suggestion: this.lastError?.suggestion });
      }
      if (e?.code === RpcErrorCode.Timeout) {
        this.stats.timeouts++;
        this.consecutiveTimeouts++;
        if (this.consecutiveTimeouts >= this.t.consecutiveTimeoutLimit) {
          this.consecutiveTimeouts = 0;
          this.killedFor = this.fail({ phase: "call", code: RpcErrorCode.Timeout, message: `连续 ${this.t.consecutiveTimeoutLimit} 次调用超时`, action: "已重启插件进程（熔断）", suggestion: "检查网络或插件逻辑，或在设置中调大超时时间" });
          this.child?.kill("SIGKILL");
        }
      }
      throw err;
    } finally {
      this.stats.totalMs += Date.now() - started;
      this.inflight.delete(seq);
      this.touchIdle();
    }
  }

  notify(method: string, params: unknown): void {
    if (this.peer && !this.peer.closed) this.peer.notify(method, params);
  }

  async stop(next: "idle" | "disabled" | "stopped"): Promise<void> {
    this.stopGen++;
    this.stopping = true;
    // Let an in-flight activation finish (or abandon itself) so its process is stopped too.
    if (this.activating) await this.activating.catch(() => {});
    this.stopping = true;
    this.stopHeartbeat();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    const peer = this.peer;
    if (child && peer && !peer.closed) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      try {
        await peer.request(Methods.shutdown, { reason: next }, { timeoutMs: this.t.stopGraceMs });
      } catch {
        // fall through to kill
      }
      const graceful = await Promise.race([exited.then(() => true), sleep(this.t.stopGraceMs).then(() => false)]);
      if (!graceful) {
        child.kill("SIGKILL");
        await Promise.race([exited, sleep(1000)]);
      }
    } else child?.kill("SIGKILL");
    this.child = null;
    this.peer = null;
    if (this._state !== "quarantined" && this._state !== "incompatible") this.setState(next === "stopped" ? "enabled" : next);
  }

  async restart(): Promise<void> {
    await this.stop("idle");
    this.nextStartAt = 0;
    await this.ensureActive();
  }

  resetFailures(): void {
    this.crashTimes = [];
    this.nextStartAt = 0;
    this.lastError = null;
    if (this._state === "quarantined" || this._state === "failed" || this._state === "disabled" || this._state === "incompatible") this.setState("enabled");
  }

  snapshot(): InstanceSnapshot {
    return {
      state: this._state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      lastError: this.lastError,
      crashes: this.crashTimes.filter((t) => Date.now() - t < this.t.crashWindowMs).length,
      stats: { ...this.stats },
      registrations: this.registrations,
      sdk: this.sdk,
      isolation: this.isolation,
      sandboxed: this.sandboxed,
      inflight: this.inflight.size,
    };
  }

  traces(): TraceEntry[] {
    return [...this.trace];
  }

  stderr(): string[] {
    return [...this.stderrTail];
  }
}
