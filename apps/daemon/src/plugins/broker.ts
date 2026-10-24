import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { matchHost, secretKeys, type Manifest } from "@harness/manifest";
import {
  type ExecParams,
  type ExecResult,
  type FetchParams,
  type FetchResult,
  type FsListParams,
  type FsReadParams,
  type LlmGenerateParams,
  type LogParams,
  Methods,
  type PermissionRequestParams,
  RpcError,
  RpcErrorCode,
  type RpcPeer,
} from "@harness/protocol";
import { registerSecretValue } from "@harness/shared";
import type { EventBus } from "../events/bus.ts";
import { pluginService, type SecretStore } from "../secrets/store.ts";
import type { AuditRepo } from "../store/repos.ts";
import { canonicalPath, type Policy, type PolicyContext } from "./policy.ts";
import type { PluginRepo } from "./repo.ts";
import { fetch as undiciFetch } from "undici";
import { createGuardedAgent, privateAddressCause, type Resolver } from "./netguard.ts";

export const EXEC_DEFAULT_TIMEOUT_MS = 10_000;
export const EXEC_MAX_TIMEOUT_MS = 30_000;
export const EXEC_MAX_OUTPUT = 1024 * 1024;
export const FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BODY = 2 * 1024 * 1024;
export const FS_DEFAULT_MAX = 256 * 1024;
export const FS_MAX = 1024 * 1024;
export const LLM_DAILY_TOKENS = 50_000;

const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

/** Host-inserted git options that neutralise repository-controlled code execution. */
export const GIT_HARDENING = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.hooksPath=/dev/null",
  "-c", "diff.external=",
  "-c", "protocol.allow=never",
  "-c", "core.sshCommand=false",
];

export type PromptDecision = "once" | "always" | "deny";

export interface Prompter {
  permission(req: { pluginId: string; permission: string; scope: unknown; reason: string }): Promise<PromptDecision>;
  confirm(req: { pluginId: string; message: string }): Promise<boolean>;
}

/** Optional OS sandbox wrapper for brokered subprocesses (M2: Seatbelt). */
export interface ExecWrapper {
  wrap(spec: { cmd: string; args: string[]; cwd: string; env: Record<string, string>; readPaths: string[]; writePaths: string[] }): Promise<{ cmd: string; args: string[]; env: Record<string, string> }>;
}

export interface BrokerDeps {
  pluginId: string;
  manifest: Manifest;
  pluginData: string;
  policy: Policy;
  repo: PluginRepo;
  audit: AuditRepo;
  secrets: SecretStore;
  bus: EventBus;
  prompter: Prompter;
  workspaces(): Array<string | null>;
  log(level: LogParams["level"], message: string, data?: unknown): void;
  llm?(params: LlmGenerateParams): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }>;
  execWrapper?: ExecWrapper;
  /** DNS resolver used by net.fetch (tests inject one to simulate DNS rebinding). */
  resolver?: Resolver;
  onGrantsChanged?(): void;
}

function denied(reason: string, data?: Record<string, unknown>): RpcError {
  return new RpcError(RpcErrorCode.PermissionDenied, reason, data);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerHostFunctions(peer: RpcPeer, d: BrokerDeps): void {
  const ctx = (): PolicyContext => ({ pluginId: d.pluginId, pluginData: d.pluginData, workspaces: d.workspaces() });
  const audit = (kind: string, permission: string | null, target: string | null, decision: "allow" | "deny", detail?: unknown) =>
    d.audit.write({ pluginId: d.pluginId, kind, permission, target, decision, detail });

  // ---- logging & notifications ---------------------------------------------------
  peer.onNotification(Methods.log, (raw) => {
    const p = raw as LogParams;
    d.log(p?.level ?? "info", String(p?.message ?? ""), p?.data);
  });

  let notifyWindow = { start: Date.now(), count: 0 };
  peer.handle(Methods.uiNotify, (raw) => {
    const p = raw as { message: string; level?: "info" | "warn" | "error" };
    const now = Date.now();
    if (now - notifyWindow.start > 60_000) notifyWindow = { start: now, count: 0 };
    if (++notifyWindow.count > 10) throw new RpcError(RpcErrorCode.QuotaExceeded, "通知过于频繁（每分钟最多 10 条）");
    d.bus.emit({ type: "ui.notify", pluginId: d.pluginId, level: p.level ?? "info", message: String(p.message).slice(0, 500) });
    return { ok: true };
  });

  peer.handle(Methods.uiConfirm, async (raw) => {
    const p = raw as { message: string };
    const dec = d.policy.checkFlag(d.pluginId, "ui.interact");
    if (!dec.ok) throw denied(dec.reason, { permission: "ui.interact" });
    return { confirmed: await d.prompter.confirm({ pluginId: d.pluginId, message: String(p.message).slice(0, 500) }) };
  });

  // ---- storage ---------------------------------------------------------------------
  const key = (k: unknown): string => {
    if (typeof k !== "string" || !k || k.length > 200 || k.startsWith("$")) throw new RpcError(RpcErrorCode.InvalidParams, "存储键必须是 1–200 个字符的字符串，且不能以 $ 开头");
    return k;
  };
  peer.handle(Methods.storageGet, (raw) => ({ value: d.repo.kvGet(d.pluginId, key((raw as { key: string }).key)) }));
  peer.handle(Methods.storageSet, (raw) => {
    const p = raw as { key: string; value: unknown; ttlSec?: number };
    try {
      d.repo.kvSet(d.pluginId, key(p.key), p.value, p.ttlSec);
    } catch (e) {
      throw new RpcError(RpcErrorCode.QuotaExceeded, (e as Error).message);
    }
    return { ok: true };
  });
  peer.handle(Methods.storageDelete, (raw) => {
    d.repo.kvDelete(d.pluginId, key((raw as { key: string }).key));
    return { ok: true };
  });

  // ---- filesystem --------------------------------------------------------------------
  peer.handle(Methods.fsRead, (raw) => {
    const p = raw as FsReadParams;
    const dec = d.policy.checkPath(ctx(), "fs.read", String(p.path));
    audit("fs.read", "fs.read", dec.ok ? (dec.path ?? p.path) : p.path, dec.ok ? "allow" : "deny", dec.ok ? undefined : { reason: dec.reason });
    if (!dec.ok) throw denied(dec.reason, { permission: "fs.read", target: p.path });
    const path = dec.path as string;
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) throw new RpcError(RpcErrorCode.InvalidParams, `文件不存在：${p.path}`);
    if (!st.isFile()) throw new RpcError(RpcErrorCode.InvalidParams, `不是普通文件：${p.path}`);
    const max = Math.min(p.maxBytes ?? FS_DEFAULT_MAX, FS_MAX);
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, len, 0);
    } finally {
      closeSync(fd);
    }
    return { content: p.encoding === "base64" ? buf.toString("base64") : buf.toString("utf8"), size: st.size, truncated: st.size > max };
  });

  peer.handle(Methods.fsList, (raw) => {
    const p = raw as FsListParams;
    const dec = d.policy.checkPath(ctx(), "fs.read", String(p.path));
    audit("fs.list", "fs.read", p.path, dec.ok ? "allow" : "deny", dec.ok ? undefined : { reason: dec.reason });
    if (!dec.ok) throw denied(dec.reason, { permission: "fs.read", target: p.path });
    const entries = readdirSync(dec.path as string, { withFileTypes: true })
      .slice(0, 2000)
      .map((e) => {
        let size = 0;
        try {
          size = e.isFile() ? statSync(`${dec.path}/${e.name}`).size : 0;
        } catch {
          // ignore races
        }
        return { name: e.name, type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other", size };
      });
    return { entries };
  });

  peer.handle(Methods.fsWrite, (raw) => {
    const p = raw as { path: string; content: string };
    const dec = d.policy.checkPath(ctx(), "fs.write", String(p.path));
    audit("fs.write", "fs.write", p.path, dec.ok ? "allow" : "deny", dec.ok ? { bytes: String(p.content ?? "").length } : { reason: dec.reason });
    if (!dec.ok) throw denied(dec.reason, { permission: "fs.write", target: p.path });
    const content = String(p.content ?? "");
    if (Buffer.byteLength(content) > FS_MAX) throw new RpcError(RpcErrorCode.QuotaExceeded, "单次写入不能超过 1MB");
    mkdirSync(dirname(dec.path as string), { recursive: true });
    writeFileSync(dec.path as string, content);
    return { bytes: Buffer.byteLength(content) };
  });

  // ---- processes ------------------------------------------------------------------------
  peer.handle(Methods.processExec, async (raw, rc) => {
    const p = raw as ExecParams;
    const args = Array.isArray(p.args) ? p.args.map(String) : [];
    const cmd = String(p.cmd ?? "");
    const dec = d.policy.checkSpawn(d.pluginId, cmd, args);
    const target = `${cmd} ${args.join(" ")}`.slice(0, 300);
    if (!dec.ok) {
      audit("process.exec", "process.spawn", target, "deny", { reason: dec.reason });
      throw denied(dec.reason, { permission: "process.spawn", target });
    }
    // The working directory must be a workspace of a calling session, or the plugin's own data dir.
    const candidates = [...d.workspaces().filter((w): w is string => !!w), d.pluginData].map(canonicalPath);
    const cwd = canonicalPath(p.cwd ?? candidates[0] ?? d.pluginData);
    if (!candidates.some((c) => cwd === c || cwd.startsWith(`${c}/`))) {
      audit("process.exec", "process.spawn", target, "deny", { reason: "cwd outside workspace", cwd });
      throw denied(`工作目录 ${cwd} 不在当前会话的工作区内`, { permission: "process.spawn", target: cwd });
    }
    const finalArgs = cmd === "git" ? [...GIT_HARDENING, ...args] : args;
    const env: Record<string, string> = {
      PATH: SAFE_PATH,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      HOME: d.pluginData,
      TMPDIR: `${d.pluginData}/tmp`,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
    };
    mkdirSync(env.TMPDIR as string, { recursive: true });
    const wrapped = d.execWrapper
      ? await d.execWrapper.wrap({ cmd, args: finalArgs, cwd, env, readPaths: candidates, writePaths: [env.TMPDIR as string] })
      : { cmd, args: finalArgs, env };
    const timeoutMs = Math.min(Math.max(p.timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS, 100), EXEC_MAX_TIMEOUT_MS);
    const started = Date.now();
    const result = await new Promise<ExecResult>((resolveP, reject) => {
      const child = spawn(wrapped.cmd, wrapped.args, { cwd, env: wrapped.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let killedBy: string | null = null;
      const kill = (why: string) => {
        killedBy = why;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => kill("timeout"), timeoutMs);
      rc.signal.addEventListener("abort", () => kill("cancelled"), { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (stdout.length + c.length > EXEC_MAX_OUTPUT) {
          stdout += c.slice(0, EXEC_MAX_OUTPUT - stdout.length);
          truncated = true;
          kill("output limit");
        } else stdout += c;
      });
      child.stderr.on("data", (c: string) => {
        if (stderr.length < 64 * 1024) stderr += c.slice(0, 64 * 1024 - stderr.length);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new RpcError(RpcErrorCode.PluginError, `无法运行 ${cmd}：${e.message}`, { code: (e as NodeJS.ErrnoException).code }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // Inside the sandbox the command is started by `env`; a missing binary shows up
        // as exit 127 instead of a spawn ENOENT. Report both the same way.
        if (d.execWrapper && code === 127 && /env: .*No such file or directory/.test(stderr)) {
          reject(new RpcError(RpcErrorCode.PluginError, `无法运行 ${cmd}：找不到这个命令`, { code: "ENOENT" }));
          return;
        }
        if (killedBy === "timeout") reject(new RpcError(RpcErrorCode.Timeout, `${cmd} 运行超过 ${timeoutMs}ms，已终止`));
        else if (killedBy === "cancelled") reject(new RpcError(RpcErrorCode.Cancelled, `${cmd} 已取消`));
        else resolveP({ stdout, stderr, exitCode: code ?? -1, truncated, durationMs: Date.now() - started });
      });
      if (p.stdin) child.stdin.end(String(p.stdin).slice(0, EXEC_MAX_OUTPUT));
      else child.stdin.end();
    });
    audit("process.exec", "process.spawn", target, "allow", { exitCode: result.exitCode, ms: result.durationMs, truncated: result.truncated, sandboxed: !!d.execWrapper });
    return result;
  });

  // ---- network ----------------------------------------------------------------------------
  const secretNames = secretKeys(d.manifest.configSchema);
  // Every connection re-checks the resolved address, so a public-looking name cannot lead to localhost / the LAN.
  const agent = createGuardedAgent((host) => d.policy.isExplicitHost(d.pluginId, host), d.resolver);
  peer.handle(Methods.netFetch, async (raw, rc) => {
    const p = raw as FetchParams;
    let url: URL;
    try {
      url = new URL(String(p.url));
    } catch {
      throw new RpcError(RpcErrorCode.InvalidParams, `URL 不合法：${p.url}`);
    }
    const method = (p.method ?? "GET").toUpperCase();
    const injected: string[] = [];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.headers ?? {})) {
      if (/^(host|content-length|connection)$/i.test(k)) continue;
      let value = String(v);
      for (const m of value.matchAll(/\{\{secret:([A-Za-z0-9_.-]+)\}\}/g)) {
        const name = m[1] as string;
        if (!secretNames.includes(name)) throw denied(`密钥 ${name} 没有在插件的 configSchema 中声明为 x-secret`, { permission: "secrets" });
        const secret = await d.secrets.get(pluginService(d.pluginId), name);
        if (!secret) throw new RpcError(RpcErrorCode.InvalidParams, `还没有配置密钥「${name}」。请在插件设置中填写，或运行 harness plugin config ${d.pluginId} --secret ${name}`, { missingSecret: name });
        registerSecretValue(secret);
        injected.push(secret);
        value = value.replace(m[0], secret);
      }
      headers[k] = value;
    }
    const timeoutMs = Math.min(p.timeoutMs ?? FETCH_DEFAULT_TIMEOUT_MS, 30_000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    rc.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    const started = Date.now();
    const origin = url.origin;
    try {
      let current = url;
      let res: Response | null = null;
      for (let hop = 0; hop <= 5; hop++) {
        const dec = d.policy.checkHost(d.pluginId, current);
        if (!dec.ok) {
          audit("net.fetch", "net.fetch", `${method} ${current.origin}${current.pathname}`, "deny", { reason: dec.reason, hop });
          throw denied(dec.reason, { permission: "net.fetch", target: current.host, host: current.hostname });
        }
        // Never forward injected secrets to a different origin after a redirect.
        const sendHeaders = current.origin === origin ? headers : Object.fromEntries(Object.entries(headers).filter(([, v]) => !injected.some((s) => v.includes(s))));
        res = (await undiciFetch(current, {
          method,
          headers: sendHeaders,
          body: method === "GET" || method === "HEAD" ? undefined : p.body,
          redirect: "manual",
          signal: ctrl.signal,
          dispatcher: agent,
        })) as unknown as Response;
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          current = new URL(res.headers.get("location") as string, current);
          continue;
        }
        break;
      }
      if (!res) throw new RpcError(RpcErrorCode.PluginError, "请求失败");
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > FETCH_MAX_BODY) {
          chunks.push(value.slice(0, FETCH_MAX_BODY - size));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        size += value.length;
      }
      let body = Buffer.concat(chunks).toString("utf8");
      for (const s of injected) body = body.replaceAll(s, "[REDACTED]");
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (!/^set-cookie$/i.test(k)) outHeaders[k] = v;
      });
      audit("net.fetch", "net.fetch", `${method} ${current.origin}${current.pathname}`, "allow", { status: res.status, bytes: size, ms: Date.now() - started, secretInjected: injected.length > 0 });
      return { status: res.status, headers: outHeaders, body, truncated } satisfies FetchResult;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      const priv = privateAddressCause(e);
      if (priv) {
        audit("net.fetch", "net.fetch", `${method} ${priv.hostname}`, "deny", { reason: priv.message });
        throw denied(`${priv.message}。宽泛的网络授权（* 或 *.域名）不能访问本机或内网服务；确有需要时，插件必须在清单中逐字声明这个主机`, {
          permission: "net.fetch",
          host: priv.hostname,
        });
      }
      if (ctrl.signal.aborted) throw new RpcError(RpcErrorCode.Timeout, `请求 ${url.host} 超时（${timeoutMs}ms）`);
      throw new RpcError(RpcErrorCode.PluginError, `请求 ${url.host} 失败：${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  });

  // ---- secrets -------------------------------------------------------------------------------
  peer.handle(Methods.secretsRead, async (raw) => {
    const name = String((raw as { key: string }).key ?? "");
    const dec = d.policy.checkName(d.pluginId, "secrets.read", name);
    audit("secrets.read", "secrets.read", name, dec.ok ? "allow" : "deny");
    if (!dec.ok) throw denied(`${dec.reason}。插件默认只能通过 {{secret:${name}}} 占位符使用密钥，拿不到明文`, { permission: "secrets.read" });
    return { value: await d.secrets.get(pluginService(d.pluginId), name) };
  });

  // ---- model ----------------------------------------------------------------------------------
  peer.handle(Methods.llmGenerate, async (raw) => {
    const p = raw as LlmGenerateParams;
    const dec = d.policy.checkFlag(d.pluginId, "llm.invoke");
    if (!dec.ok) {
      audit("llm.generate", "llm.invoke", null, "deny");
      throw denied(dec.reason, { permission: "llm.invoke" });
    }
    if (!d.llm) throw new RpcError(RpcErrorCode.NotActive, "宿主当前没有可用的模型");
    const budgetKey = `$host:llm:${today()}`;
    const used = Number(d.repo.kvGet(d.pluginId, budgetKey) ?? 0);
    if (used >= LLM_DAILY_TOKENS) throw new RpcError(RpcErrorCode.QuotaExceeded, `插件今天的模型额度已用完（${LLM_DAILY_TOKENS} tokens）`);
    const out = await d.llm({ prompt: String(p.prompt ?? "").slice(0, 200_000), system: p.system, maxOutputTokens: Math.min(p.maxOutputTokens ?? 2000, 8000) });
    const spent = (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0);
    d.repo.kvSet(d.pluginId, budgetKey, used + spent, 2 * 86_400);
    audit("llm.generate", "llm.invoke", null, "allow", { tokens: spent });
    return out;
  });

  // ---- runtime permission requests -----------------------------------------------------------
  peer.handle(Methods.permissionsRequest, async (raw) => {
    const p = raw as PermissionRequestParams;
    const declared = [...(d.manifest.permissions?.optional ?? []), ...(d.manifest.permissions?.required ?? [])].filter((x) => x.id === p.permission);
    if (!declared.length) throw denied(`权限 ${p.permission} 没有在清单中声明，不能在运行时申请`, { permission: p.permission });
    const requested = Array.isArray(p.scope) ? p.scope.map(String) : p.scope === undefined ? [] : [String(p.scope)];
    const allowedByDecl = declared.some((x) => {
      if (x.scope === undefined || (Array.isArray(x.scope) && x.scope.includes("*"))) return true;
      const pats = (Array.isArray(x.scope) ? x.scope : [x.scope]).map(String);
      if (p.permission === "net.fetch") return requested.every((h) => matchHost(pats, new URL(`https://${h}`)));
      return requested.every((r) => pats.includes(r));
    });
    if (!allowedByDecl) throw denied(`申请的范围 ${requested.join("、")} 超出了清单中为 ${p.permission} 声明的范围`, { permission: p.permission });
    const already =
      p.permission === "net.fetch"
        ? requested.length > 0 && requested.every((h) => d.policy.checkHost(d.pluginId, new URL(`https://${h}`)).ok)
        : d.policy.has(d.pluginId, p.permission);
    if (already) return { granted: true, decision: "already" };
    const decision = await d.prompter.permission({ pluginId: d.pluginId, permission: p.permission, scope: requested.length ? requested : undefined, reason: String(p.reason ?? "") });
    audit("permission.request", p.permission, requested.join(",") || null, decision === "deny" ? "deny" : "allow", { decision, reason: p.reason });
    if (decision === "always") d.repo.addGrant(d.pluginId, p.permission, requested.length ? requested : undefined, "runtime");
    if (decision === "once") d.policy.allowOnce(d.pluginId, p.permission, requested.length ? requested : undefined);
    if (decision !== "deny") d.onGrantsChanged?.();
    return { granted: decision !== "deny", decision };
  });

  // Not provided in this phase: answer explicitly instead of hanging.
  for (const m of [Methods.sessionContext, Methods.toolsInvoke, Methods.uiInput]) {
    peer.handle(m, () => {
      throw new RpcError(RpcErrorCode.MethodNotFound, `${m} 在当前版本的宿主中尚未提供`);
    });
  }
}
