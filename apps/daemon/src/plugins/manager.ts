import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, type FSWatcher, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  configDefaults,
  describeScope,
  type Issue,
  loadAndValidate,
  type Manifest,
  MANIFEST_FILE,
  permissionInfo,
  secretKeys,
  validateConfig,
  type PanelContribution,
} from "@harness/manifest";
import { applyPatch, type CommandRunResult, type HookDecision, Methods, RpcError, type ToolCallResult } from "@harness/protocol";
import { ErrorCode, HarnessError, newId, nowIso, type PluginState, registerSecretValue } from "@harness/shared";
import { generateText } from "ai";
import semver from "semver";
import { type HookEvent, type HookOutcome, type HookRunner, type RegisteredTool, type ToolExecContext, ToolFailure, type ToolSource } from "../agent/tools.ts";
import { type Daemon, REPO_ROOT, type Subsystem, VERSION } from "../daemon.ts";
import { pluginService } from "../secrets/store.ts";
import { type ActionView, ActionStore, type AppliedAction } from "./actions.ts";
import { type ExecWrapper, type PromptDecision, type Prompter, registerHostFunctions } from "./broker.ts";
import { buildLaunch, type LaunchSpec } from "./launcher.ts";
import { createSandbox, describeSandbox, type OsSandbox } from "../sandbox/seatbelt.ts";
import type { Resolver } from "./netguard.ts";
import { Policy } from "./policy.ts";
import { type PluginRow, PluginRepo } from "./repo.ts";
import { type InstanceSnapshot, type PluginInstance, ProcessSupervisor, type SupervisorTiming } from "./supervisor.ts";

export const CHECKSUM_FILE = ".harness-checksums.json";
const COPY_EXCLUDE = new Set(["node_modules", ".git", "target", "test", "tests", "__pycache__", ".DS_Store", ".venv", CHECKSUM_FILE]);
const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;
const PROMPT_TIMEOUT_MS = 2 * 60_000;

export interface LoadedPlugin {
  id: string;
  version: string;
  manifest: Manifest;
  dir: string;
  dev: boolean;
  source: string;
  enabled: boolean;
  quarantined: string | null;
  incompatible: string | null;
  invalid: Issue[] | null;
  instance: PluginInstance | null;
  watcher?: FSWatcher;
}

export interface InstanceFactoryContext {
  plugin: LoadedPlugin;
  pluginData: string;
  manager: PluginManager;
}

export interface ManagerOptions {
  timing?: Partial<SupervisorTiming>;
  /** Overrides catalog directories (tests). Defaults to <repo>/plugins + config.catalogs + $HARNESS_CATALOG. */
  catalogDirs?: string[];
  safeMode?: boolean;
  promptTimeoutMs?: number;
  /** OS sandbox for plugin processes and brokered subprocesses. Defaults to macOS Seatbelt. */
  sandbox?: OsSandbox;
  /** Overrides how brokered subprocesses are wrapped (tests). */
  execWrapper?: ExecWrapper;
  /** DNS resolver for plugin network requests (tests). */
  netResolver?: Resolver;
  /** Creates instances for non-process runtimes (M3: wasm). */
  instanceFactories?: Partial<Record<string, (ctx: InstanceFactoryContext) => PluginInstance>>;
}

export interface PermissionView {
  id: string;
  label: string;
  risk: string;
  explain: string;
  scope: unknown;
  scopeText: string;
  reason: string;
  required: boolean;
  granted: boolean;
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
  lastError: InstanceSnapshot["lastError"] | { message: string; suggestion?: string } | null;
  contributes: { tools: string[]; commands: string[]; hooks: string[]; panels: Array<{ id: string; title: string; location: string }>; skills: boolean };
  permissions: PermissionView[];
  stats: InstanceSnapshot["stats"] | null;
  isolation: string[];
  sandboxed: boolean;
  pid: number | null;
}

interface PendingPrompt {
  kind: "permission" | "confirm";
  pluginId: string;
  sessionId?: string;
  resolve(decision: PromptDecision): void;
  timer: NodeJS.Timeout;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, base, out);
    else if (e.isFile()) out.push(relative(base, full));
  }
  return out;
}

function setTreeMode(dir: string, writable: boolean): void {
  if (!existsSync(dir)) return;
  const visit = (d: string) => {
    if (writable) chmodSync(d, 0o755);
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile()) chmodSync(full, writable ? 0o644 : 0o444);
    }
    if (!writable) chmodSync(d, 0o555);
  };
  visit(dir);
}

export function computeChecksums(dir: string): { files: Record<string, string>; digest: string } {
  const files: Record<string, string> = {};
  for (const rel of walkFiles(dir).sort()) if (rel !== CHECKSUM_FILE) files[rel] = sha256(readFileSync(join(dir, rel)));
  return { files, digest: sha256(JSON.stringify(files)) };
}

function readmeOf(dir: string, name: string): string | null {
  const f = join(dir, name);
  return existsSync(f) ? readFileSync(f, "utf8").slice(0, 20_000) : null;
}

export class PluginManager implements Subsystem, ToolSource, HookRunner, Prompter {
  readonly name = "plugins";
  readonly id = "plugins";
  readonly repo: PluginRepo;
  readonly policy: Policy;
  readonly daemon: Daemon;
  readonly opts: ManagerOptions;
  readonly safeMode: boolean;
  readonly actions: ActionStore;
  traceSubscribers = 0;
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly sessionsByPlugin = new Map<string, Map<number, string>>();
  private seq = 0;

  constructor(daemon: Daemon, opts: ManagerOptions = {}) {
    this.daemon = daemon;
    this.opts = opts;
    this.repo = new PluginRepo(daemon.db);
    this.policy = new Policy(this.repo, daemon.paths);
    this.actions = new ActionStore(daemon.paths);
    this.safeMode = opts.safeMode ?? daemon.env.HARNESS_SAFE_MODE === "1";
    this.ownsSandbox = !opts.sandbox;
    const off = daemon.env.HARNESS_SANDBOX === "off" || (daemon.env.HARNESS_SANDBOX !== "auto" && daemon.config.sandbox === "off");
    this.sandbox = opts.sandbox ?? createSandbox({ mode: off ? "off" : "auto" });
  }
  readonly sandbox: OsSandbox;
  private readonly ownsSandbox: boolean;

  // ---- lifecycle ---------------------------------------------------------------

  async start(): Promise<void> {
    const sb = await this.sandbox.ready();
    if (sb.mode !== "seatbelt") this.daemon.logger.warn({ sandbox: sb }, "OS sandbox is not active");
    mkdirSync(this.daemon.paths.pluginsStoreDir, { recursive: true });
    mkdirSync(this.daemon.paths.pluginsDataDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.daemon.paths.pluginLogsDir, { recursive: true, mode: 0o700 });
    for (const row of this.repo.list()) this.load(row);
    this.daemon.tools.addSource(this);
    this.daemon.hooks = this;
    if (this.safeMode) {
      this.daemon.logger.warn("safe mode: no plugins are loaded");
      return;
    }
    for (const p of this.loaded.values()) if (this.isRunnable(p) && this.keepAlive(p)) void p.instance?.ensureActive().catch(() => {});
  }

  /** Pending dev-mode reloads (debounced file events); cleared on stop. */
  private readonly devTimers = new Set<NodeJS.Timeout>();
  private stopped = false;

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.devTimers) clearTimeout(t);
    this.devTimers.clear();
    for (const p of this.loaded.values()) p.watcher?.close();
    await Promise.allSettled([...this.loaded.values()].map((p) => p.instance?.stop("stopped")));
    for (const pr of this.prompts.values()) pr.resolve("deny");
    if (this.ownsSandbox) await this.sandbox.dispose();
  }

  status() {
    const list = [...this.loaded.values()];
    return { installed: list.length, active: list.filter((p) => p.instance?.state === "active").length, safeMode: this.safeMode, sandbox: this.sandbox.status() };
  }

  pluginData(id: string): string {
    const d = join(this.daemon.paths.pluginsDataDir, id);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  logFile(id: string): string {
    return join(this.daemon.paths.pluginLogsDir, `${id}.log`);
  }

  private keepAlive(p: LoadedPlugin): boolean {
    return (p.manifest.contributes?.hooks?.length ?? 0) > 0 || (p.manifest.activation ?? []).includes("onStartup");
  }

  private isRunnable(p: LoadedPlugin): boolean {
    return !this.safeMode && p.enabled && !p.quarantined && !p.incompatible && !p.invalid && !!p.instance;
  }

  private load(row: PluginRow): LoadedPlugin | null {
    const prev = this.loaded.get(row.id);
    prev?.watcher?.close();
    const ver = this.repo.getVersion(row.id, row.version);
    const dir = row.dev_path ?? ver?.path ?? "";
    let manifest = ver ? (JSON.parse(ver.manifest) as Manifest) : null;
    let invalid: Issue[] | null = null;
    let incompatible: string | null = null;
    if (!dir || !existsSync(join(dir, MANIFEST_FILE))) invalid = [{ code: "missing_file", path: "/", message: `插件文件丢失：${dir}`, hint: "重新安装插件" }];
    else {
      const v = loadAndValidate(dir, VERSION);
      if (v.manifest) manifest = v.manifest;
      if (v.incompatible) incompatible = v.errors.map((e) => e.message).join("；");
      else if (!v.ok) invalid = v.errors;
      if (!invalid && !row.dev_path) {
        const sumFile = join(dir, CHECKSUM_FILE);
        if (existsSync(sumFile)) {
          const expected = JSON.parse(readFileSync(sumFile, "utf8")) as { files: Record<string, string> };
          const actual = computeChecksums(dir).files;
          const changed = [...new Set([...Object.keys(expected.files), ...Object.keys(actual)])].filter((f) => expected.files[f] !== actual[f]);
          if (changed.length)
            invalid = [{ code: "missing_file", path: "/", message: `插件文件在安装后被修改：${changed.slice(0, 5).join("、")}`, hint: `为安全起见已停止加载。请重新安装：harness plugin uninstall ${row.id} 后再安装` }];
        }
      }
    }
    if (!manifest) return null;
    const p: LoadedPlugin = {
      id: row.id,
      version: manifest.version,
      manifest,
      dir,
      dev: !!row.dev_path,
      source: row.source,
      enabled: row.enabled === 1,
      quarantined: row.quarantined_reason,
      incompatible,
      invalid,
      instance: null,
    };
    p.instance = this.createInstance(p);
    this.loaded.set(p.id, p);
    if (p.dev) this.watchDev(p);
    return p;
  }

  private createInstance(p: LoadedPlugin): PluginInstance | null {
    const type = p.manifest.runtime.type;
    if (type === "none") return null;
    const pluginData = this.pluginData(p.id);
    const factory = this.opts.instanceFactories?.[type];
    if (factory) return factory({ plugin: p, pluginData, manager: this });
    if (type !== "node" && type !== "python") return null;
    const sup: ProcessSupervisor = new ProcessSupervisor({
      pluginId: p.id,
      version: p.version,
      manifest: p.manifest,
      bus: this.daemon.bus,
      logFile: this.logFile(p.id),
      hostInfo: { name: "harness", version: VERSION },
      timing: this.opts.timing,
      keepAlive: () => this.keepAlive(p),
      traceEnabled: () => p.dev || this.traceSubscribers > 0,
      launch: () =>
        this.wrapLaunch(p, buildLaunch({
          manifest: p.manifest,
          dir: p.dir,
          pluginData,
          dev: p.dev,
          envNames: this.policy.grants(p.id).filter((g) => g.permission === "env.read").flatMap((g) => (Array.isArray(g.scope) ? g.scope.map(String) : [])),
          hostEnv: this.daemon.env,
        })),
      initParams: () => this.initParams(p, pluginData),
      registerHost: (peer, inst) => this.registerHost(p, peer, inst, pluginData, (lvl, msg, data) => sup.log(lvl, msg, data)),
      onQuarantine: (reason) => {
        p.quarantined = reason;
        this.repo.setQuarantine(p.id, reason);
        this.daemon.audit.write({ pluginId: p.id, kind: "plugin.quarantine", decision: "info", detail: { reason } });
        this.daemon.bus.emit({ type: "plugins.changed" });
      },
    });
    return sup;
  }

  initParams(p: LoadedPlugin, pluginData: string) {
    return {
      plugin: { id: p.id, version: p.version },
      grants: this.policy.grants(p.id).map((g) => ({ permission: g.permission, scope: g.scope })),
      config: this.effectiveConfig(p),
      workspace: { root: this.daemon.config.workspace ?? null },
      paths: { pluginData },
      limits: { callTimeoutMs: p.manifest.limits?.callTimeoutMs ?? 30_000, hookTimeoutMs: p.manifest.limits?.hookTimeoutMs ?? 2_000 },
      dev: p.dev,
    };
  }

  /** Wires the broker for a process instance. Exposed so other runtimes (wasm) can reuse policy + audit. */
  registerHost(p: LoadedPlugin, peer: Parameters<typeof registerHostFunctions>[0], inst: PluginInstance, pluginData: string, log: (lvl: string, msg: string, data?: unknown) => void): void {
    registerHostFunctions(peer, {
      pluginId: p.id,
      manifest: p.manifest,
      pluginData,
      policy: this.policy,
      repo: this.repo,
      audit: this.daemon.audit,
      secrets: this.daemon.secrets,
      bus: this.daemon.bus,
      prompter: this,
      workspaces: () => [...inst.activeWorkspaces(), this.daemon.config.workspace ?? null],
      log,
      llm: (params) => this.llm(params),
      execWrapper: this.opts.execWrapper ?? (this.sandbox.active ? this.execWrapperFor(p.id) : undefined),
      resolver: this.opts.netResolver,
      onGrantsChanged: () => inst.notify(Methods.grantsDidChange, { grants: this.policy.grants(p.id).map((g) => ({ permission: g.permission, scope: g.scope })) }),
    });
  }

  /** Puts a plugin process inside the OS sandbox (or explains why it cannot run without one). */
  private async wrapLaunch(p: LoadedPlugin, spec: LaunchSpec): Promise<LaunchSpec> {
    const st = this.sandbox.status();
    const note = describeSandbox(st);
    if (!this.sandbox.active) {
      if (spec.requiresOsSandbox) throw new Error(`${p.manifest.runtime.type} 插件没有进程内的权限限制，必须运行在 macOS Seatbelt 沙箱中；${note}`);
      return { ...spec, isolation: [...spec.isolation, note] };
    }
    const w = await this.sandbox.wrap({ command: spec.command, args: spec.args, env: spec.env, readPaths: spec.readPaths, writePaths: spec.writePaths, id: p.id });
    return { ...spec, command: w.command, args: w.args, env: w.env, sandboxed: true, isolation: [...spec.isolation, note] };
  }

  /** Commands the Broker runs for a plugin (git, ...) get their own sandbox: read the workspace, write only scratch. */
  private execWrapperFor(id: string): ExecWrapper {
    return {
      wrap: async (s) => {
        const w = await this.sandbox.wrap({ command: s.cmd, args: s.args, env: s.env, readPaths: s.readPaths, writePaths: s.writePaths, id: `${id}.exec` });
        return { cmd: w.command, args: w.args, env: w.env };
      },
    };
  }

  private async llm(params: { prompt: string; system?: string; maxOutputTokens?: number }) {
    const model = await this.daemon.getModel();
    const r = await generateText({ model, system: params.system, prompt: params.prompt, maxOutputTokens: params.maxOutputTokens });
    return { text: r.text, usage: { inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens } };
  }

  private watchDev(p: LoadedPlugin): void {
    let timer: NodeJS.Timeout | null = null;
    try {
      p.watcher = watch(p.dir, { recursive: true }, (_ev, file) => {
        const f = String(file ?? "");
        if (/(^|\/)(node_modules|\.git|target|__pycache__)(\/|$)/.test(f) || f.endsWith(".log")) return;
        if (this.stopped) return;
        if (timer) {
          clearTimeout(timer);
          this.devTimers.delete(timer);
        }
        const t = setTimeout(() => {
          this.devTimers.delete(t);
          this.reloadDev(p.id, f).catch((err) => this.daemon.logger.warn({ err, plugin: p.id }, "dev reload failed"));
        }, 300);
        timer = t;
        this.devTimers.add(t);
      });
    } catch (err) {
      this.daemon.logger.warn({ err, plugin: p.id }, "dev watch failed");
    }
  }

  private async reloadDev(id: string, file: string): Promise<void> {
    if (this.stopped) return;
    const p = this.loaded.get(id);
    const row = this.repo.get(id);
    if (!p || !row) return;
    await p.instance?.stop("idle");
    const next = this.load(row);
    this.daemon.bus.emit({ type: "plugin.state", pluginId: id, state: next?.instance?.state ?? "failed", detail: `开发模式：检测到 ${file} 变化，已重新加载` });
    this.daemon.bus.emit({ type: "plugins.changed" });
    if (next && this.isRunnable(next) && this.keepAlive(next)) void next.instance?.ensureActive().catch(() => {});
  }

  // ---- queries -------------------------------------------------------------------

  get(id: string): LoadedPlugin | undefined {
    return this.loaded.get(id);
  }

  private require(id: string): LoadedPlugin {
    const p = this.loaded.get(id);
    if (!p) throw new HarnessError(ErrorCode.InvalidParams, `没有安装插件 ${id}。运行 harness plugin list 查看已安装的插件`);
    return p;
  }

  stateOf(p: LoadedPlugin): { state: PluginState; detail: string | null } {
    if (this.safeMode) return { state: "disabled", detail: "安全模式：所有插件均未加载" };
    if (!p.enabled) return { state: "disabled", detail: null };
    if (p.quarantined) return { state: "quarantined", detail: p.quarantined };
    if (p.incompatible) return { state: "incompatible", detail: p.incompatible };
    if (p.invalid) return { state: "failed", detail: p.invalid.map((i) => i.message).join("；") };
    if (!p.instance) return { state: "enabled", detail: p.manifest.runtime.type === "none" ? "纯声明式插件（无代码）" : null };
    return { state: p.instance.state, detail: null };
  }

  permissionViews(p: { id: string; manifest: Manifest }): PermissionView[] {
    const grants = this.repo.grants(p.id);
    const view = (req: { id: string; scope?: unknown; reason: string }, required: boolean): PermissionView => {
      const info = permissionInfo(req.id);
      return {
        id: req.id,
        label: info?.label ?? req.id,
        risk: info?.risk ?? "high",
        explain: info?.explain ?? "",
        scope: req.scope,
        scopeText: describeScope(req.id, req.scope),
        reason: req.reason,
        required,
        granted: grants.some((g) => g.permission === req.id),
      };
    };
    return [...(p.manifest.permissions?.required ?? []).map((r) => view(r, true)), ...(p.manifest.permissions?.optional ?? []).map((r) => view(r, false))];
  }

  summary(p: LoadedPlugin): PluginSummary {
    const snap = p.instance?.snapshot() ?? null;
    const st = this.stateOf(p);
    const c = p.manifest.contributes ?? {};
    return {
      id: p.id,
      name: p.manifest.name,
      version: p.version,
      description: p.manifest.description,
      author: p.manifest.author?.name ?? null,
      runtime: p.manifest.runtime.type,
      dev: p.dev,
      source: p.source,
      enabled: p.enabled,
      state: st.state,
      stateDetail: st.detail,
      lastError: p.invalid ? { message: st.detail ?? "", suggestion: p.invalid[0]?.hint } : (snap?.lastError ?? null),
      contributes: {
        tools: (c.tools ?? []).map((t) => t.name),
        commands: (c.commands ?? []).map((t) => t.name),
        hooks: (c.hooks ?? []).map((h) => h.event),
        panels: (c.panels ?? []).map((x) => ({ id: x.id, title: x.title, location: x.location })),
        skills: !!c.skills,
      },
      permissions: this.permissionViews(p),
      stats: snap?.stats ?? null,
      isolation: snap?.isolation ?? [],
      sandboxed: snap?.sandboxed ?? false,
      pid: snap?.pid ?? null,
    };
  }

  list(): PluginSummary[] {
    return [...this.loaded.values()].map((p) => this.summary(p));
  }

  /** A declared panel of an enabled, healthy plugin; null otherwise (the panel server serves nothing else). */
  panelFor(pluginId: string, panelId: string): { plugin: LoadedPlugin; panel: PanelContribution } | null {
    if (this.safeMode) return null;
    const p = this.loaded.get(pluginId);
    if (!p || !p.enabled || p.quarantined || p.incompatible || p.invalid) return null;
    if (!this.policy.has(p.id, "ui.panel")) return null; // revoking ui.panel hides the plugin's panels
    const panel = p.manifest.contributes?.panels?.find((x) => x.id === panelId);
    return panel ? { plugin: p, panel } : null;
  }

  /** Set by the panel server once it listens. */
  panelServer: { origin: string | null; urlFor(pluginId: string, panelId: string): string | null } | null = null;

  panelOrigin(): string | null {
    return this.panelServer?.origin ?? null;
  }

  panelUrl(pluginId: string, panelId: string): string | null {
    return this.panelServer?.urlFor(pluginId, panelId) ?? null;
  }

  /** Panels contributed by enabled plugins, for the UI's panel sidebar. */
  panels(): Array<{ pluginId: string; pluginName: string; panelId: string; title: string; location: "sidebar" | "main"; capabilities: string[] }> {
    const out: ReturnType<PluginManager["panels"]> = [];
    for (const p of this.loaded.values()) {
      for (const panel of p.manifest.contributes?.panels ?? []) {
        if (!this.panelFor(p.id, panel.id)) continue;
        out.push({ pluginId: p.id, pluginName: p.manifest.name, panelId: panel.id, title: panel.title, location: panel.location, capabilities: panel.capabilities ?? [] });
      }
    }
    return out;
  }

  /**
   * A request a panel sent over the postMessage bridge, relayed by the UI. Panels can only
   * reach their own plugin's tools, only if the manifest grants the panel `tools.call`, and
   * anything other than a read-only tool needs the user's confirmation in the host UI.
   */
  async panelCall(pluginId: string, panelId: string, method: string, params: Record<string, unknown>, opts: { workspace: string | null; confirmed?: boolean }): Promise<{ ok: boolean; output: unknown; durationMs: number }> {
    const found = this.panelFor(pluginId, panelId);
    if (!found) throw new HarnessError(ErrorCode.NotActive, `面板 ${pluginId}/${panelId} 不存在，或插件没有启用`);
    const { panel, plugin } = found;
    if (method !== "tools/call") throw new HarnessError(ErrorCode.MethodNotFound, `面板不支持的方法：${method}`);
    if (!(panel.capabilities ?? []).includes("tools.call")) {
      throw new HarnessError(ErrorCode.PermissionDenied, `面板「${panel.title}」没有在清单中声明 tools.call 能力，不能调用工具`, { hint: "在 contributes.panels[].capabilities 中加入 \"tools.call\"" });
    }
    const name = String(params.name ?? "");
    const tool = plugin.manifest.contributes?.tools?.find((t) => t.name === name);
    if (!tool) throw new HarnessError(ErrorCode.PermissionDenied, `面板只能调用插件 ${pluginId} 自己的工具，${name || "（空）"} 不属于它`);
    const risk = tool.risk ?? "read";
    if (risk !== "read" && opts.confirmed !== true) {
      throw new HarnessError(ErrorCode.PermissionDenied, `面板请求运行有副作用的工具 ${name}（${risk}），需要你在界面上确认`, { needsConfirmation: true, risk });
    }
    this.daemon.audit.write({ pluginId, kind: "panel.tools.call", permission: null, target: `${panelId} → ${name}`, decision: "allow", detail: { risk, confirmed: opts.confirmed === true } });
    const started = Date.now();
    try {
      const output = await this.callTool(pluginId, name, params.arguments ?? {}, {
        sessionId: `panel:${pluginId}/${panelId}`,
        turnId: newId("turn"),
        callId: newId("call"),
        workspace: opts.workspace,
        signal: new AbortController().signal,
      });
      return { ok: true, output, durationMs: Date.now() - started };
    } catch (err) {
      if (err instanceof ToolFailure) return { ok: false, output: err.payload, durationMs: Date.now() - started };
      throw err;
    }
  }

  detail(id: string) {
    const p = this.require(id);
    const keys = secretKeys(p.manifest.configSchema);
    return {
      ...this.summary(p),
      manifest: p.manifest,
      dir: p.dir,
      readme: readmeOf(p.dir, "README.md"),
      changelog: readmeOf(p.dir, "CHANGELOG.md"),
      grants: this.repo.grants(id),
      settings: this.effectiveConfig(p),
      secretKeys: keys,
      versions: this.repo.versions(id).map((v) => ({ version: v.version, installedAt: v.installed_at, verified: v.verified })),
      snapshot: p.instance?.snapshot() ?? null,
      issues: p.invalid ?? [],
      kvBytes: this.repo.kvUsage(id),
    };
  }

  async secretsConfigured(id: string): Promise<Record<string, boolean>> {
    const p = this.require(id);
    const out: Record<string, boolean> = {};
    for (const k of secretKeys(p.manifest.configSchema)) out[k] = !!(await this.daemon.secrets.get(pluginService(id), k));
    return out;
  }

  logs(id: string, lines = 200): string[] {
    this.require(id);
    const f = this.logFile(id);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-lines);
  }

  traces(id: string) {
    return this.require(id).instance?.traces() ?? [];
  }

  catalogDirs(): string[] {
    if (this.opts.catalogDirs) return this.opts.catalogDirs;
    return [join(REPO_ROOT, "plugins"), ...this.daemon.config.catalogs, ...(this.daemon.env.HARNESS_CATALOG ?? "").split(":").filter(Boolean)];
  }

  discover() {
    const out: Array<{ id: string; name: string; version: string; description: string; runtime: string; dir: string; installed: string | null; updateAvailable: boolean; valid: boolean; problems: string[] }> = [];
    for (const root of this.catalogDirs()) {
      if (!existsSync(root)) continue;
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = join(root, e.name);
        if (!existsSync(join(dir, MANIFEST_FILE))) continue;
        const v = loadAndValidate(dir, VERSION);
        const m = v.manifest;
        if (!m) continue;
        const installed = this.repo.get(m.id)?.version ?? null;
        out.push({
          id: m.id,
          name: m.name,
          version: m.version,
          description: m.description,
          runtime: m.runtime.type,
          dir,
          installed,
          updateAvailable: !!installed && !!semver.valid(m.version) && !!semver.valid(installed) && semver.gt(m.version, installed),
          valid: v.ok,
          problems: v.errors.map((x) => x.message),
        });
      }
    }
    return out;
  }

  // ---- install / uninstall ------------------------------------------------------------

  private resolveSource(source: string): { dir: string; kind: "dir" | "package" | "catalog"; cleanup(): void; origin: string } {
    const noop = () => {};
    const abs = resolve(source);
    if (existsSync(abs) && statSync(abs).isDirectory()) return { dir: abs, kind: "dir", cleanup: noop, origin: abs };
    if (existsSync(abs) && abs.endsWith(".harnessplugin")) {
      const tmp = mkdtempSync(join(this.daemon.paths.cacheDir, "pkg-"));
      try {
        execFileSync("/usr/bin/tar", ["-xzf", abs, "-C", tmp], { stdio: "pipe" });
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        throw new HarnessError(ErrorCode.InvalidParams, `无法解压插件包：${(e as Error).message}`);
      }
      const inner = existsSync(join(tmp, MANIFEST_FILE)) ? tmp : join(tmp, readdirSync(tmp)[0] ?? "");
      return { dir: inner, kind: "package", cleanup: () => rmSync(tmp, { recursive: true, force: true }), origin: abs };
    }
    const hit = this.discover().find((c) => c.id === source || basename(c.dir) === source || c.name.toLowerCase() === source.toLowerCase());
    if (hit) return { dir: hit.dir, kind: "catalog", cleanup: noop, origin: hit.dir };
    throw new HarnessError(ErrorCode.InvalidParams, `找不到插件来源「${source}」`, { hint: "可以是插件目录、.harnessplugin 文件，或 harness plugin catalog 中列出的名字" });
  }

  /** Validates a source without executing any plugin code (install review page). */
  inspect(source: string) {
    const src = this.resolveSource(source);
    try {
      const v = loadAndValidate(src.dir, VERSION);
      const m = v.manifest;
      const existing = m ? this.repo.get(m.id) : undefined;
      const conflicts = m ? this.conflicts(m) : [];
      let integrity: "ok" | "mismatch" | "none" = "none";
      if (existsSync(join(src.dir, CHECKSUM_FILE))) {
        const expected = JSON.parse(readFileSync(join(src.dir, CHECKSUM_FILE), "utf8")) as { files: Record<string, string> };
        integrity = JSON.stringify(expected.files) === JSON.stringify(computeChecksums(src.dir).files) ? "ok" : "mismatch";
      }
      return {
        source: src.origin,
        kind: src.kind,
        ok: v.ok && conflicts.length === 0 && integrity !== "mismatch",
        errors: [...v.errors, ...conflicts.map((c) => ({ code: "duplicate" as const, path: "/contributes", message: c }))],
        warnings: v.warnings,
        incompatible: v.incompatible,
        integrity,
        manifest: m ?? null,
        existing: existing ? { version: existing.version, dev: !!existing.dev_path } : null,
        permissions: m ? this.permissionViews({ id: `__review__${m.id}`, manifest: m }) : [],
        isolation:
          m?.runtime.type === "node"
            ? ["独立进程 + Node 权限模型（只读插件目录、只写数据目录、禁止子进程）", describeSandbox(this.sandbox.status()), "所有文件、网络、命令访问都经过宿主授权检查并记录审计"]
            : m?.runtime.type === "python"
              ? ["独立进程（Python 隔离模式）", this.sandbox.active ? describeSandbox(this.sandbox.status()) : `${describeSandbox(this.sandbox.status())}：Python 插件在这种情况下无法运行`, "所有文件、网络、命令访问都经过宿主授权检查并记录审计"]
              : m?.runtime.type === "wasm"
                ? ["WebAssembly 沙箱：没有任何文件、网络或进程能力，内存与执行时间受限"]
                : ["纯声明式插件，不包含可执行代码"],
      };
    } finally {
      src.cleanup();
    }
  }

  private conflicts(m: Manifest): string[] {
    const out: string[] = [];
    for (const p of this.loaded.values()) {
      if (p.id === m.id) continue;
      for (const t of m.contributes?.tools ?? []) if ((p.manifest.contributes?.tools ?? []).some((x) => x.name === t.name)) out.push(`工具名 ${t.name} 已被插件 ${p.manifest.name}（${p.id}）使用`);
      for (const c of m.contributes?.commands ?? []) if ((p.manifest.contributes?.commands ?? []).some((x) => x.name === c.name)) out.push(`命令 /${c.name} 已被插件 ${p.manifest.name}（${p.id}）使用`);
    }
    return out;
  }

  async install(source: string, opts: { dev?: boolean; enable?: boolean; grantOptional?: string[] } = {}): Promise<PluginSummary> {
    const src = this.resolveSource(source);
    try {
      const v = loadAndValidate(src.dir, VERSION);
      if (!v.ok || !v.manifest) {
        const first = v.errors[0];
        const more = v.errors.length > 1 ? `（另有 ${v.errors.length - 1} 处问题，运行 harness plugin validate 查看全部）` : "";
        const head = v.incompatible ? "插件与当前 Harness 版本不兼容" : "插件清单校验失败";
        throw new HarnessError(ErrorCode.InvalidParams, first ? `${head}：${first.message}${first.path ? `（${first.path}）` : ""}${more}` : head, { issues: v.errors, warnings: v.warnings, hint: first?.hint });
      }
      const m = v.manifest;
      const existing = this.repo.get(m.id);
      if (existing && !(opts.dev && existing.dev_path)) {
        throw new HarnessError(ErrorCode.InvalidParams, `插件 ${m.id} 已安装（版本 ${existing.version}）`, { hint: `要换成这个版本，请先运行 harness plugin uninstall ${m.id}，或使用 harness plugin update ${m.id} ${source}` });
      }
      const conflicts = this.conflicts(m);
      if (conflicts.length) throw new HarnessError(ErrorCode.InvalidParams, conflicts.join("；"), { issues: conflicts.map((message) => ({ path: "/contributes", message })) });
      const { target, verified } = opts.dev ? { target: src.dir, verified: "dev" } : this.stage(src.dir, m);
      this.repo.upsert({
        id: m.id,
        version: m.version,
        enabled: opts.enable === false ? 0 : 1,
        source: opts.dev ? "dev" : src.kind,
        previous_version: null,
        quarantined_reason: null,
        dev_path: opts.dev ? src.dir : null,
      });
      this.repo.addVersion({ plugin_id: m.id, version: m.version, path: target, manifest: JSON.stringify(m), source: src.origin, verified });
      if (!existing) {
        for (const r of m.permissions?.required ?? []) this.repo.addGrant(m.id, r.id, r.scope, "install");
        for (const o of m.permissions?.optional ?? []) if (opts.grantOptional?.includes(o.id)) this.repo.addGrant(m.id, o.id, o.scope, "user");
        if (!Object.keys(this.repo.settings(m.id)).length) this.repo.setSettings(m.id, configDefaults(m.configSchema));
      }
      this.pluginData(m.id);
      this.daemon.audit.write({ pluginId: m.id, kind: "plugin.install", decision: "info", detail: { version: m.version, source: src.origin, dev: !!opts.dev, verified, grantedOptional: opts.grantOptional ?? [] } });
      const p = this.load(this.repo.get(m.id) as PluginRow);
      this.daemon.bus.emit({ type: "plugins.changed" });
      if (p && this.isRunnable(p) && this.keepAlive(p)) void p.instance?.ensureActive().catch(() => {});
      return this.summary(p as LoadedPlugin);
    } finally {
      src.cleanup();
    }
  }

  /** Copies a verified source into the read-only store as <id>@<version>. */
  private stage(srcDir: string, m: Manifest): { target: string; verified: string } {
    if (existsSync(join(srcDir, CHECKSUM_FILE))) {
      const expected = JSON.parse(readFileSync(join(srcDir, CHECKSUM_FILE), "utf8")) as { files: Record<string, string> };
      if (JSON.stringify(expected.files) !== JSON.stringify(computeChecksums(srcDir).files)) throw new HarnessError(ErrorCode.InvalidParams, "插件包的文件校验和不匹配，可能已被篡改", { hint: "从可信来源重新获取插件包" });
    }
    const target = join(this.daemon.paths.pluginsStoreDir, `${m.id}@${m.version}`);
    if (existsSync(target)) {
      setTreeMode(target, true);
      rmSync(target, { recursive: true, force: true });
    }
    cpSync(srcDir, target, { recursive: true, filter: (s) => !COPY_EXCLUDE.has(basename(s)) });
    const sums = computeChecksums(target);
    const bytes = Object.keys(sums.files).reduce((n, f) => n + statSync(join(target, f)).size, 0);
    if (bytes > MAX_PLUGIN_BYTES) {
      rmSync(target, { recursive: true, force: true });
      throw new HarnessError(ErrorCode.QuotaExceeded, `插件体积 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过上限 50MB`);
    }
    writeFileSync(join(target, CHECKSUM_FILE), JSON.stringify({ files: sums.files }, null, 2));
    setTreeMode(target, false);
    return { target, verified: `sha256:${sums.digest}` };
  }

  /**
   * Upgrades an installed plugin. Grants, settings and data are kept; permissions the
   * new version newly requires must be accepted explicitly. The old version stays in
   * the store so `rollback` can switch back.
   */
  async update(id: string, opts: { source?: string; acceptPermissions?: boolean } = {}): Promise<{ plugin: PluginSummary; from: string; to: string; newPermissions: string[] }> {
    const p = this.require(id);
    const row = this.repo.get(id) as PluginRow;
    if (row.dev_path) throw new HarnessError(ErrorCode.InvalidParams, "开发模式安装的插件直接使用源码目录，改动保存后会自动重启，不需要更新", { hint: `需要手动重启时运行 harness plugin restart ${id}` });
    const source = opts.source ?? this.discover().find((c) => c.id === id)?.dir;
    if (!source) throw new HarnessError(ErrorCode.InvalidParams, `找不到 ${id} 的更新来源`, { hint: `指定来源：harness plugin update ${id} <目录或 .harnessplugin 文件>` });
    const src = this.resolveSource(source);
    try {
      const v = loadAndValidate(src.dir, VERSION);
      if (!v.ok || !v.manifest) throw new HarnessError(ErrorCode.InvalidParams, v.incompatible ? "新版本与当前 Harness 不兼容" : "新版本的清单校验失败", { issues: v.errors, warnings: v.warnings });
      const m = v.manifest;
      if (m.id !== id) throw new HarnessError(ErrorCode.InvalidParams, `来源中的插件是 ${m.id}，不是 ${id}`);
      if (!semver.gt(m.version, row.version)) throw new HarnessError(ErrorCode.InvalidParams, `已经是最新版本（已安装 ${row.version}，来源中是 ${m.version}）`);
      const conflicts = this.conflicts(m);
      if (conflicts.length) throw new HarnessError(ErrorCode.InvalidParams, conflicts.join("；"));
      const granted = new Set(this.repo.grants(id).map((g) => g.permission));
      const added = (m.permissions?.required ?? []).filter((r) => !granted.has(r.id));
      if (added.length && !opts.acceptPermissions)
        throw new HarnessError(ErrorCode.PermissionDenied, `新版本 ${m.version} 需要新的权限：${added.map((r) => `${permissionInfo(r.id)?.label ?? r.id}（${r.reason}）`).join("；")}`, {
          hint: `确认后运行 harness plugin update ${id} --accept-permissions`,
          newPermissions: added.map((r) => r.id),
        });
      p.watcher?.close();
      await p.instance?.stop("stopped");
      const { target, verified } = this.stage(src.dir, m);
      for (const r of added) this.repo.addGrant(id, r.id, r.scope, "update");
      const known = Object.keys(((m.configSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}));
      const kept = Object.fromEntries(Object.entries(this.repo.settings(id)).filter(([k]) => known.includes(k)));
      this.repo.setSettings(id, { ...configDefaults(m.configSchema), ...kept });
      this.repo.upsert({ id, version: m.version, enabled: row.enabled, source: src.kind, previous_version: row.version, quarantined_reason: null, dev_path: null, installed_at: row.installed_at });
      this.repo.addVersion({ plugin_id: id, version: m.version, path: target, manifest: JSON.stringify(m), source: src.origin, verified });
      this.daemon.audit.write({ pluginId: id, kind: "plugin.update", decision: "info", detail: { from: row.version, to: m.version, newPermissions: added.map((r) => r.id), verified } });
      return { plugin: this.reload(id), from: row.version, to: m.version, newPermissions: added.map((r) => r.id) };
    } finally {
      src.cleanup();
    }
  }

  /** Switches back to the previously installed version (files are re-verified on load). */
  async rollback(id: string): Promise<{ plugin: PluginSummary; from: string; to: string }> {
    const p = this.require(id);
    const row = this.repo.get(id) as PluginRow;
    const prev = row.previous_version;
    const ver = prev ? this.repo.getVersion(id, prev) : undefined;
    if (!prev || !ver || !existsSync(ver.path)) throw new HarnessError(ErrorCode.InvalidParams, `插件 ${id} 没有可回滚的旧版本`);
    p.watcher?.close();
    await p.instance?.stop("stopped");
    this.repo.upsert({ id, version: prev, enabled: row.enabled, source: row.source, previous_version: row.version, quarantined_reason: null, dev_path: null, installed_at: row.installed_at });
    this.daemon.audit.write({ pluginId: id, kind: "plugin.rollback", decision: "info", detail: { from: row.version, to: prev } });
    return { plugin: this.reload(id), from: row.version, to: prev };
  }

  private reload(id: string): PluginSummary {
    this.loaded.delete(id);
    const np = this.load(this.repo.get(id) as PluginRow) as LoadedPlugin;
    this.daemon.bus.emit({ type: "plugins.changed" });
    if (np && this.isRunnable(np) && this.keepAlive(np)) void np.instance?.ensureActive().catch(() => {});
    return this.summary(np);
  }

  async uninstall(id: string, opts: { keepData?: boolean } = {}): Promise<void> {
    const p = this.require(id);
    p.watcher?.close();
    await p.instance?.stop("stopped");
    for (const v of this.repo.versions(id)) {
      if (v.path.startsWith(this.daemon.paths.pluginsStoreDir)) {
        setTreeMode(v.path, true);
        rmSync(v.path, { recursive: true, force: true });
      }
    }
    for (const k of secretKeys(p.manifest.configSchema)) await this.daemon.secrets.delete(pluginService(id), k);
    if (!opts.keepData) {
      this.repo.kvClear(id);
      rmSync(join(this.daemon.paths.pluginsDataDir, id), { recursive: true, force: true });
    }
    this.repo.delete(id);
    this.loaded.delete(id);
    this.daemon.audit.write({ pluginId: id, kind: "plugin.uninstall", decision: "info", detail: { keepData: !!opts.keepData } });
    this.daemon.bus.emit({ type: "plugins.changed" });
  }

  async enable(id: string): Promise<PluginSummary> {
    const p = this.require(id);
    this.repo.setEnabled(id, true);
    this.repo.setQuarantine(id, null);
    p.enabled = true;
    p.quarantined = null;
    p.instance?.resetFailures();
    this.daemon.audit.write({ pluginId: id, kind: "plugin.enable", decision: "info" });
    this.daemon.bus.emit({ type: "plugins.changed" });
    if (this.isRunnable(p) && this.keepAlive(p)) void p.instance?.ensureActive().catch(() => {});
    return this.summary(p);
  }

  async disable(id: string): Promise<PluginSummary> {
    const p = this.require(id);
    this.repo.setEnabled(id, false);
    p.enabled = false;
    await p.instance?.stop("disabled");
    this.daemon.audit.write({ pluginId: id, kind: "plugin.disable", decision: "info" });
    this.daemon.bus.emit({ type: "plugins.changed" });
    return this.summary(p);
  }

  async restart(id: string): Promise<PluginSummary> {
    const p = this.require(id);
    if (!this.isRunnable(p)) throw new HarnessError(ErrorCode.NotActive, `插件当前状态是 ${this.stateOf(p).state}，不能重启`, { hint: p.quarantined ? `先运行 harness plugin enable ${id}` : undefined });
    await p.instance?.restart();
    return this.summary(p);
  }

  // ---- settings, secrets, grants ------------------------------------------------------

  effectiveConfig(p: LoadedPlugin): Record<string, unknown> {
    return { ...configDefaults(p.manifest.configSchema), ...this.repo.settings(p.id) };
  }

  setSettings(id: string, values: Record<string, unknown>): Record<string, unknown> {
    const p = this.require(id);
    const secrets = secretKeys(p.manifest.configSchema);
    const bad = Object.keys(values).filter((k) => secrets.includes(k));
    if (bad.length) throw new HarnessError(ErrorCode.InvalidParams, `${bad.join("、")} 是密钥，请用 harness plugin config ${id} --secret ${bad[0]} 设置（会存进钥匙串）`);
    const props = Object.keys((p.manifest.configSchema?.properties ?? {}) as object);
    const unknown = Object.keys(values).filter((k) => !props.includes(k));
    if (unknown.length) throw new HarnessError(ErrorCode.InvalidParams, `未知的设置项：${unknown.join("、")}`, { hint: `可用设置项：${props.filter((k) => !secrets.includes(k)).join("、") || "（无）"}` });
    const merged = { ...this.effectiveConfig(p), ...values };
    const schema = { ...(p.manifest.configSchema ?? {}), required: ((p.manifest.configSchema?.required as string[] | undefined) ?? []).filter((k) => !secrets.includes(k)) };
    const issues = validateConfig(schema, merged);
    if (issues.length) throw new HarnessError(ErrorCode.InvalidParams, `设置不合法：${issues.map((i) => `${i.path} ${i.message}`).join("；")}`, { issues });
    this.repo.setSettings(id, merged);
    p.instance?.notify(Methods.configDidChange, { config: merged });
    this.daemon.audit.write({ pluginId: id, kind: "plugin.config", decision: "info", detail: { keys: Object.keys(values) } });
    this.daemon.bus.emit({ type: "plugins.changed" });
    return merged;
  }

  async setSecret(id: string, key: string, value: string | null): Promise<void> {
    const p = this.require(id);
    if (!secretKeys(p.manifest.configSchema).includes(key)) throw new HarnessError(ErrorCode.InvalidParams, `插件没有声明名为 ${key} 的密钥`);
    if (value === null) await this.daemon.secrets.delete(pluginService(id), key);
    else {
      if (!value.trim()) throw new HarnessError(ErrorCode.InvalidParams, "密钥不能为空");
      registerSecretValue(value.trim());
      await this.daemon.secrets.set(pluginService(id), key, value.trim());
    }
    this.daemon.audit.write({ pluginId: id, kind: value === null ? "secret.delete" : "secret.set", target: `plugin:${id}:${key}`, decision: "info" });
    this.daemon.bus.emit({ type: "plugins.changed" });
  }

  grant(id: string, permission: string, scope?: unknown): { grantId: string } {
    const p = this.require(id);
    const decl = [...(p.manifest.permissions?.required ?? []), ...(p.manifest.permissions?.optional ?? [])].find((x) => x.id === permission);
    if (!decl) throw new HarnessError(ErrorCode.InvalidParams, `插件没有在清单中声明权限 ${permission}，不能授予`);
    const grantId = this.repo.addGrant(id, permission, scope ?? decl.scope, "user");
    this.daemon.audit.write({ pluginId: id, kind: "grant.add", permission, target: describeScope(permission, scope ?? decl.scope), decision: "allow" });
    p.instance?.notify(Methods.grantsDidChange, { grants: this.policy.grants(id).map((g) => ({ permission: g.permission, scope: g.scope })) });
    this.daemon.bus.emit({ type: "plugins.changed" });
    return { grantId };
  }

  revoke(id: string, permission: string): { revoked: number; warning?: string } {
    const p = this.require(id);
    const revoked = this.repo.revokePermission(id, permission);
    this.daemon.audit.write({ pluginId: id, kind: "grant.revoke", permission, decision: "deny", detail: { revoked } });
    p.instance?.notify(Methods.grantsDidChange, { grants: this.policy.grants(id).map((g) => ({ permission: g.permission, scope: g.scope })) });
    this.daemon.bus.emit({ type: "plugins.changed" });
    const required = (p.manifest.permissions?.required ?? []).some((r) => r.id === permission);
    return { revoked, warning: required ? `${permission} 是这个插件的必需权限，撤销后相关功能会失败（会明确报“权限被拒绝”）` : undefined };
  }

  // ---- prompts (runtime permission requests and confirmations) -------------------------

  private activeSession(pluginId: string): string | undefined {
    return [...(this.sessionsByPlugin.get(pluginId)?.values() ?? [])][0];
  }

  private track(pluginId: string, sessionId: string | undefined): () => void {
    if (!sessionId) return () => {};
    const key = ++this.seq;
    let m = this.sessionsByPlugin.get(pluginId);
    if (!m) this.sessionsByPlugin.set(pluginId, (m = new Map()));
    m.set(key, sessionId);
    return () => m?.delete(key);
  }

  private prompt(kind: PendingPrompt["kind"], pluginId: string, emit: (requestId: string, sessionId?: string) => void): Promise<PromptDecision> {
    const requestId = newId("prm");
    const sessionId = this.activeSession(pluginId);
    return new Promise((resolveP) => {
      const finish = (decision: PromptDecision) => {
        const pending = this.prompts.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.prompts.delete(requestId);
        this.daemon.bus.emit({ type: "permission.resolved", requestId, decision, sessionId });
        resolveP(decision);
      };
      const timer = setTimeout(() => finish("deny"), this.opts.promptTimeoutMs ?? PROMPT_TIMEOUT_MS);
      this.prompts.set(requestId, { kind, pluginId, sessionId, resolve: finish, timer });
      emit(requestId, sessionId);
    });
  }

  permission(req: { pluginId: string; permission: string; scope: unknown; reason: string }): Promise<PromptDecision> {
    const info = permissionInfo(req.permission);
    const name = this.loaded.get(req.pluginId)?.manifest.name;
    return this.prompt("permission", req.pluginId, (requestId, sessionId) =>
      this.daemon.bus.emit({ type: "permission.request", requestId, pluginId: req.pluginId, pluginName: name, permission: req.permission, label: info?.label, risk: info?.risk, scope: describeScope(req.permission, req.scope), reason: req.reason, sessionId }),
    );
  }

  async confirm(req: { pluginId: string; message: string }): Promise<boolean> {
    const name = this.loaded.get(req.pluginId)?.manifest.name;
    const d = await this.prompt("confirm", req.pluginId, (requestId, sessionId) => this.daemon.bus.emit({ type: "confirm.request", requestId, pluginId: req.pluginId, pluginName: name, message: req.message, sessionId }));
    return d !== "deny";
  }

  resolvePrompt(requestId: string, decision: PromptDecision): boolean {
    const p = this.prompts.get(requestId);
    if (!p) return false;
    p.resolve(decision);
    return true;
  }

  pendingPrompts(): string[] {
    return [...this.prompts.keys()];
  }

  // ---- tools -----------------------------------------------------------------------------

  listTools(): RegisteredTool[] {
    const out: RegisteredTool[] = [];
    for (const p of this.loaded.values()) {
      if (!this.isRunnable(p)) continue;
      for (const t of p.manifest.contributes?.tools ?? []) {
        const timeoutMs = Math.min(t.timeoutMs ?? p.manifest.limits?.callTimeoutMs ?? 30_000, 600_000);
        out.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          risk: t.risk,
          pluginId: p.id,
          timeoutMs,
          execute: (input, ctx) => this.callTool(p.id, t.name, input, ctx, timeoutMs),
        });
      }
    }
    return out;
  }

  async callTool(id: string, name: string, input: unknown, ctx: ToolExecContext, timeoutMs?: number): Promise<unknown> {
    const p = this.require(id);
    if (!this.isRunnable(p)) throw new HarnessError(ErrorCode.NotActive, `插件 ${p.manifest.name} 当前不可用（${this.stateOf(p).state}）`);
    const tool = (p.manifest.contributes?.tools ?? []).find((t) => t.name === name);
    if (!tool) throw new HarnessError(ErrorCode.MethodNotFound, `插件 ${id} 没有声明工具 ${name}`);
    const limit = timeoutMs ?? Math.min(tool.timeoutMs ?? p.manifest.limits?.callTimeoutMs ?? 30_000, 600_000);
    const untrack = this.track(id, ctx.sessionId);
    try {
      const res = await (p.instance as PluginInstance).call<ToolCallResult>(
        Methods.toolCall,
        { name, arguments: input, callId: ctx.callId, deadlineMs: Date.now() + limit, session: { id: ctx.sessionId, turnId: ctx.turnId, workspace: ctx.workspace } },
        { timeoutMs: limit, signal: ctx.signal, workspace: ctx.workspace },
      );
      if (res?.isError) {
        const sc = (res.structuredContent ?? {}) as { error?: string; message?: string };
        const text = res.content?.find((c) => c.type === "text") as { text?: string } | undefined;
        throw new ToolFailure({ ...sc, error: sc.error ?? "tool_error", message: sc.message ?? text?.text ?? "工具执行失败" });
      }
      if (res?.structuredContent !== undefined) return res.structuredContent;
      const text = (res?.content ?? []).filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
      return text;
    } catch (err) {
      if (err instanceof RpcError) throw new HarnessError(err.code, err.message, this.withFixHint(p, err.code, err.data));
      throw err;
    } finally {
      untrack();
    }
  }

  // ---- commands ------------------------------------------------------------------------

  commands(): Array<{ name: string; description: string; args?: string; pluginId: string; pluginName: string }> {
    const out = [];
    for (const p of this.loaded.values()) {
      if (!this.isRunnable(p)) continue;
      for (const c of p.manifest.contributes?.commands ?? []) out.push({ name: c.name, description: c.description, args: c.args, pluginId: p.id, pluginName: p.manifest.name });
    }
    return out;
  }

  async runCommand(
    name: string,
    args: string[],
    opts: { sessionId?: string; workspace?: string | null; signal?: AbortSignal } = {},
  ): Promise<Omit<CommandRunResult, "actions"> & { pluginId: string; actions: ActionView[]; actionProblems: string[] }> {
    const cmd = this.commands().find((c) => c.name === name);
    if (!cmd) throw new HarnessError(ErrorCode.MethodNotFound, `没有插件提供命令 /${name}`, { hint: `可用命令：${this.commands().map((c) => `/${c.name}`).join("、") || "（无）"}` });
    const p = this.require(cmd.pluginId);
    const untrack = this.track(p.id, opts.sessionId);
    const workspace = opts.workspace ?? this.daemon.config.workspace ?? null;
    try {
      const out = await (p.instance as PluginInstance).call<CommandRunResult>(
        Methods.commandRun,
        { name, args, session: { id: opts.sessionId ?? "cli", workspace } },
        { timeoutMs: p.manifest.limits?.callTimeoutMs ?? 60_000, signal: opts.signal, workspace },
      );
      const { views, problems } = this.actions.register(p.id, workspace, out?.actions);
      return { ...out, actions: views, actionProblems: problems, pluginId: p.id };
    } catch (err) {
      if (err instanceof RpcError) throw new HarnessError(err.code, err.message, this.withFixHint(p, err.code, err.data));
      throw err;
    } finally {
      untrack();
    }
  }

  /** Adds an actionable hint to permission errors so users know how to fix them. */
  withFixHint(p: { id: string; manifest: Manifest }, code: number, data: unknown): Record<string, unknown> | undefined {
    const d = (data && typeof data === "object" ? { ...(data as Record<string, unknown>) } : undefined) as Record<string, unknown> | undefined;
    if (code !== ErrorCode.PermissionDenied || d?.hint) return d;
    const perm = typeof d?.permission === "string" ? d.permission : null;
    const declared = perm && [...(p.manifest.permissions?.required ?? []), ...(p.manifest.permissions?.optional ?? [])].some((x) => x.id === perm);
    const hint = !perm
      ? `运行 harness plugin info ${p.id} 查看这个插件的权限`
      : declared
        ? `如果信任这个插件，运行 harness plugin grant ${p.id} ${perm}；查看全部权限：harness plugin info ${p.id}`
        : `插件没有在清单中声明 ${perm}，无法授予；这通常需要插件作者修改清单`;
    return { ...d, hint };
  }

  /** Performs a host-side action the user confirmed (e.g. writing CHANGELOG.md). */
  applyAction(id: string): AppliedAction {
    const view = this.actions.get(id);
    try {
      const done = this.actions.apply(id);
      this.daemon.audit.write({ pluginId: done.pluginId, kind: "action.write-file", target: done.absPath, decision: "allow", detail: { mode: done.mode, bytes: done.bytes, confirmedBy: "user" } });
      return done;
    } catch (err) {
      if (view) this.daemon.audit.write({ pluginId: view.pluginId, kind: "action.write-file", target: view.path, decision: "deny", detail: { error: (err as Error).message } });
      throw err instanceof HarnessError ? err : new HarnessError(ErrorCode.PermissionDenied, (err as Error).message);
    }
  }

  // ---- hooks -----------------------------------------------------------------------------

  async run<T>(event: HookEvent, payload: T, meta: { sessionId: string; turnId: string }): Promise<HookOutcome<T>> {
    const notes: HookOutcome<T>["notes"] = [];
    const entries = [...this.loaded.values()]
      .filter((p) => this.isRunnable(p))
      .flatMap((p) => (p.manifest.contributes?.hooks ?? []).filter((h) => h.event === event).map((h) => ({ p, h })))
      .sort((a, b) => (a.h.order ?? 0) - (b.h.order ?? 0) || a.p.id.localeCompare(b.p.id));
    if (!entries.length) return { payload, notes };
    const workspace = this.daemon.sessions.get(meta.sessionId)?.workspace ?? null;
    let current = payload;
    for (const { p, h } of entries) {
      const critical = !!h.critical && this.policy.has(p.id, "hooks.critical");
      const timeoutMs = Math.min(h.timeoutMs ?? p.manifest.limits?.hookTimeoutMs ?? (critical ? 5_000 : 2_000), 5_000);
      const name = p.manifest.name;
      const untrack = this.track(p.id, meta.sessionId);
      try {
        const dec = await (p.instance as PluginInstance).call<HookDecision>(
          Methods.hookInvoke,
          { event, payload: current, session: { id: meta.sessionId, turnId: meta.turnId, workspace } },
          { timeoutMs, workspace },
        );
        if (!dec || dec.action === "continue") {
          if (dec?.note) notes.push({ pluginId: p.id, note: dec.note });
        } else if (dec.action === "block") {
          this.daemon.audit.write({ pluginId: p.id, kind: "hook.block", target: event, decision: "deny", detail: { reason: dec.reason, rule: dec.rule } });
          return { payload: current, blocked: { reason: dec.reason, pluginId: p.id, rule: dec.rule }, notes };
        } else if (dec.action === "modify") {
          if (!this.policy.has(p.id, "session.modify")) {
            this.daemon.audit.write({ pluginId: p.id, kind: "hook.modify", target: event, decision: "deny", detail: { reason: "missing session.modify" } });
            notes.push({ pluginId: p.id, note: `插件 ${name} 想修改 ${event} 的内容，但没有 session.modify 权限，已忽略这次修改` });
          } else {
            current = applyPatch(current, dec.patch);
            this.daemon.audit.write({ pluginId: p.id, kind: "hook.modify", target: event, decision: "allow", detail: { ops: dec.patch.map((o) => `${o.op} ${o.path}`) } });
            if (dec.note) notes.push({ pluginId: p.id, note: dec.note });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.daemon.audit.write({ pluginId: p.id, kind: "hook.error", target: event, decision: critical ? "deny" : "info", detail: { error: msg, critical } });
        if (critical) return { payload: current, blocked: { reason: `关键插件 ${name} 的 ${event} 拦截器出错（${msg}），为安全起见已暂停这次操作`, pluginId: p.id, rule: "fail_closed" }, notes };
        notes.push({ pluginId: p.id, note: `插件 ${name} 的 ${event} 钩子出错（${msg}），已跳过` });
      } finally {
        untrack();
      }
    }
    return { payload: current, notes };
  }

  stamp(): string {
    return nowIso();
  }
}
