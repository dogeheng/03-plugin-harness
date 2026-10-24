import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sensitivePaths } from "@harness/manifest";

/**
 * OS-level sandbox for plugin processes and for commands the Broker runs on a
 * plugin's behalf (e.g. git). On macOS this is Seatbelt (sandbox-exec), driven by
 * Anthropic's sandbox-runtime (srt), which generates a "deny default" profile per
 * invocation:
 *
 *   - reads:   allowed by default, but the whole home directory is denied and only the
 *              listed paths are put back; sensitive paths (~/.ssh, keychains, browser
 *              data, ...) are denied again on top, even inside an allowed path;
 *   - writes:  denied everywhere except the listed paths;
 *   - network: denied (plugins reach the network only through the Broker).
 *
 * This is the third layer: the Broker checks every host call, the Node permission
 * model restricts Node plugins in-process, and Seatbelt holds even if both are
 * bypassed (or for runtimes such as Python that have no in-process permission model).
 */

export type SandboxMode = "seatbelt" | "degraded" | "off";

export interface SandboxStatus {
  mode: SandboxMode;
  /** Why the sandbox is not active (degraded / off). */
  reason?: string;
  engine?: string;
}

export interface WrapRequest {
  command: string;
  args: string[];
  /** Exact environment of the sandboxed process (nothing else is inherited). */
  env: Record<string, string>;
  /** Paths readable despite the home-directory deny (directories or files). */
  readPaths: string[];
  /** The only writable paths. */
  writePaths: string[];
  /** Correlation id for violation reports (plugin id + purpose). */
  id: string;
}

export interface WrappedCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface OsSandbox {
  status(): SandboxStatus;
  /** True when processes are actually wrapped. */
  readonly active: boolean;
  /** Resolves once the startup self-check finished (never rejects). */
  ready(): Promise<SandboxStatus>;
  wrap(req: WrapRequest): Promise<WrappedCommand>;
  dispose(): Promise<void>;
}

export interface SandboxOptions {
  mode?: "auto" | "off";
  /** Defaults to /usr/bin/sandbox-exec. Overridable for tests (degraded mode). */
  sandboxExec?: string;
  /** Home directory to deny (defaults to the real one). */
  home?: string;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SHELL = "/bin/sh";
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** POSIX single-quote escaping. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./=:@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** A sandbox that wraps nothing (mode "off" or "degraded"). */
class PassThroughSandbox implements OsSandbox {
  readonly active = false;
  private readonly st: SandboxStatus;
  constructor(st: SandboxStatus) {
    this.st = st;
  }
  status(): SandboxStatus {
    return this.st;
  }
  async ready(): Promise<SandboxStatus> {
    return this.st;
  }
  async wrap(req: WrapRequest): Promise<WrappedCommand> {
    return { command: req.command, args: req.args, env: req.env };
  }
  async dispose(): Promise<void> {}
}

// sandbox-runtime keeps process-wide state (its network proxies), so it is
// initialised once and shared by every daemon in this process (tests start many).
type SrtManager = typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;
let srtShared: { manager: SrtManager; refs: number } | null = null;
let srtInit: Promise<SrtManager> | null = null;

async function acquireSrt(): Promise<SrtManager> {
  if (srtShared) {
    srtShared.refs++;
    return srtShared.manager;
  }
  srtInit ??= (async () => {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    // Base policy: no network, no extra paths. Every wrap supplies its own policy.
    await SandboxManager.initialize({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } });
    return SandboxManager;
  })();
  try {
    const manager = await srtInit;
    const cur = srtShared as { manager: SrtManager; refs: number } | null;
    if (cur) cur.refs++;
    else srtShared = { manager, refs: 1 };
    return manager;
  } catch (e) {
    srtInit = null;
    throw e;
  }
}

async function releaseSrt(): Promise<void> {
  if (!srtShared) return;
  srtShared.refs--;
  if (srtShared.refs > 0) return;
  const m = srtShared.manager;
  srtShared = null;
  srtInit = null;
  await (m as unknown as { reset?: () => Promise<void> }).reset?.();
}

class SeatbeltSandbox implements OsSandbox {
  private st: SandboxStatus = { mode: "degraded", reason: "正在自检" };
  private srt: SrtManager | null = null;
  private readonly home: string;
  private readonly readyP: Promise<SandboxStatus>;
  private readonly opts: SandboxOptions;

  constructor(opts: SandboxOptions) {
    this.opts = opts;
    this.home = real(opts.home ?? homedir());
    this.readyP = this.selfCheck();
  }

  get active(): boolean {
    return this.st.mode === "seatbelt";
  }
  status(): SandboxStatus {
    return this.st;
  }
  ready(): Promise<SandboxStatus> {
    return this.readyP;
  }

  private async selfCheck(): Promise<SandboxStatus> {
    const exe = this.opts.sandboxExec ?? SANDBOX_EXEC;
    const degrade = (reason: string): SandboxStatus => (this.st = { mode: "degraded", reason });
    if (process.platform !== "darwin") return degrade("只支持 macOS");
    if (!existsSync(exe)) return degrade(`找不到 ${exe}（这个 macOS 版本可能已移除 sandbox-exec）`);
    const probe = spawnSync(exe, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 5000 });
    if (probe.status !== 0) return degrade(`sandbox-exec 无法运行：${(probe.stderr || probe.error?.message || `退出码 ${probe.status}`).trim()}（常见原因：Harness 本身运行在另一个沙箱里）`);
    if (this.opts.sandboxExec && this.opts.sandboxExec !== SANDBOX_EXEC) return degrade(`sandbox-runtime 只能使用 ${SANDBOX_EXEC}`);
    try {
      this.srt = await acquireSrt();
      // End-to-end check: a wrapped process must run, and must not read the home dir.
      const w = await this.wrapWith(this.srt, { command: "/bin/ls", args: [this.home], env: { PATH: SAFE_PATH }, readPaths: [], writePaths: [], id: "harness.selfcheck" });
      const r = spawnSync(w.command, w.args, { env: w.env, encoding: "utf8", timeout: 10_000 });
      if (r.status === 0) return degrade("自检失败：沙箱中的进程仍能读取家目录");
      const t = await this.wrapWith(this.srt, { command: "/usr/bin/true", args: [], env: { PATH: SAFE_PATH }, readPaths: [], writePaths: [], id: "harness.selfcheck" });
      const ok = spawnSync(t.command, t.args, { env: t.env, encoding: "utf8", timeout: 10_000 });
      if (ok.status !== 0) return degrade(`自检失败：沙箱中的进程无法启动（${(ok.stderr || "").trim().slice(0, 200)}）`);
      this.st = { mode: "seatbelt", engine: "macOS Seatbelt（sandbox-runtime）" };
      return this.st;
    } catch (e) {
      return degrade(`sandbox-runtime 初始化失败：${(e as Error).message}`);
    }
  }

  async wrap(req: WrapRequest): Promise<WrappedCommand> {
    await this.readyP;
    if (!this.srt || !this.active) return { command: req.command, args: req.args, env: req.env };
    return this.wrapWith(this.srt, req);
  }

  private async wrapWith(srt: SrtManager, req: WrapRequest): Promise<WrappedCommand> {
    // `env -i` inside the sandbox: the process gets exactly req.env, not the proxy
    // variables sandbox-runtime adds (plugins have no direct network anyway).
    const envArgs = Object.entries(req.env).map(([k, v]) => shellQuote(`${k}=${v}`));
    const inner = ["/usr/bin/env", "-i", ...envArgs, shellQuote(req.command), ...req.args.map(shellQuote)].join(" ");
    const sensitive = sensitivePaths(this.home);
    const wrapped = await srt.wrapWithSandbox(
      inner,
      undefined,
      {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          // Deny the whole home, put back what the process needs, then deny the
          // sensitive locations again (a more specific deny wins over an allow).
          denyRead: [this.home, ...sensitive],
          allowRead: req.readPaths.map(real),
          allowWrite: req.writePaths.map(real),
          // srt always allows writing /tmp/claude; plugins must not share a scratch dir.
          denyWrite: ["/tmp/claude", "/private/tmp/claude", ...sensitive],
        },
      },
      undefined,
      { commandId: req.id },
    );
    // `sh -c` execs the single command chain (env → sandbox-exec → sh → env → target),
    // so the spawned pid is the target process and signals reach it directly.
    return { command: SHELL, args: ["-c", wrapped], env: { PATH: SAFE_PATH } };
  }

  async dispose(): Promise<void> {
    if (this.srt) {
      this.srt = null;
      await releaseSrt();
    }
  }
}

/** Creates the OS sandbox; the self-check runs in the background (see ready()). */
export function createSandbox(opts: SandboxOptions = {}): OsSandbox {
  if (opts.mode === "off") return new PassThroughSandbox({ mode: "off", reason: "已在配置中关闭（sandbox: \"off\" 或 HARNESS_SANDBOX=off）" });
  return new SeatbeltSandbox(opts);
}

export function describeSandbox(s: SandboxStatus): string {
  if (s.mode === "seatbelt") return "macOS Seatbelt 沙箱：家目录默认不可读（只放回插件需要的目录），敏感路径始终拒绝，只能写自己的数据目录，禁止直接联网";
  if (s.mode === "off") return `OS 沙箱已关闭：${s.reason ?? ""}`;
  return `OS 沙箱不可用（降级模式）：${s.reason ?? "未知原因"}`;
}
