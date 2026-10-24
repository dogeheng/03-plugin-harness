import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Manifest } from "@harness/manifest";

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Human-readable description of the isolation applied. */
  isolation: string[];
  sandboxed: boolean;
  /** Paths the process must be able to read under the OS sandbox's home deny. */
  readPaths: string[];
  /** The only paths the process may write. */
  writePaths: string[];
  /** Runtimes without an in-process permission model must not run unsandboxed. */
  requiresOsSandbox: boolean;
}

export interface LaunchContext {
  manifest: Manifest;
  dir: string;
  pluginData: string;
  dev: boolean;
  inspect?: boolean;
  /** Env var names granted through env.read. */
  envNames?: string[];
  hostEnv?: NodeJS.ProcessEnv;
}

export const DEFAULT_NODE_MEMORY_MB = 256;
/** The bundled Node runtime (bin/, lib/) must stay readable inside the sandbox. */
const NODE_RUNTIME_ROOT = realpathSync(dirname(dirname(process.execPath)));
const SAFE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

export function baseEnv(ctx: LaunchContext): Record<string, string> {
  const tmp = join(ctx.pluginData, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    PATH: SAFE_PATH,
    LANG: "en_US.UTF-8",
    HOME: ctx.pluginData,
    TMPDIR: tmp,
    HARNESS_PROTOCOL: "1",
    HARNESS_PLUGIN_ID: ctx.manifest.id,
  };
  for (const name of ctx.envNames ?? []) {
    const v = ctx.hostEnv?.[name];
    if (v !== undefined && !/^(HARNESS_|NODE_OPTIONS$)/.test(name)) env[name] = v;
  }
  return env;
}

export function buildLaunch(ctx: LaunchContext): LaunchSpec {
  const { manifest } = ctx;
  // macOS: /var and /tmp are symlinks into /private. The Node permission model checks
  // resolved paths, so grant the canonical locations.
  const dir = realpathSync(ctx.dir);
  const pluginData = realpathSync(ctx.pluginData);
  const entry = join(dir, manifest.runtime.entry ?? "");
  const env = baseEnv(ctx);
  let spec: LaunchSpec;
  switch (manifest.runtime.type) {
    case "node": {
      const mem = Math.min(manifest.limits?.memoryMb ?? DEFAULT_NODE_MEMORY_MB, 512);
      const args = [
        "--permission",
        `--allow-fs-read=${dir}`,
        `--allow-fs-read=${pluginData}`,
        `--allow-fs-write=${pluginData}`,
        `--max-old-space-size=${mem}`,
        "--disable-warning=ExperimentalWarning",
        "--disable-proto=delete",
      ];
      if (ctx.dev && ctx.inspect) args.push("--allow-inspector", "--inspect=127.0.0.1:0");
      args.push(entry);
      spec = {
        command: process.execPath,
        args,
        env,
        cwd: pluginData,
        sandboxed: false,
        readPaths: [dir, pluginData, NODE_RUNTIME_ROOT],
        writePaths: [pluginData],
        requiresOsSandbox: false,
        isolation: [`独立进程（Node ${process.versions.node}）`, "Node 权限模型：只读插件目录，只写插件数据目录，禁止子进程与 Worker", `堆内存上限 ${mem}MB`, "环境变量已清空（仅保留白名单）"],
      };
      break;
    }
    case "python": {
      const py = manifest.runtime.python ?? "python3";
      spec = {
        command: py,
        args: ["-I", "-B", "-u", entry],
        env: { ...env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" },
        cwd: pluginData,
        sandboxed: false,
        readPaths: [dir, pluginData],
        writePaths: [pluginData],
        requiresOsSandbox: true,
        isolation: ["独立进程（Python，隔离模式 -I）", "环境变量已清空（仅保留白名单）"],
      };
      break;
    }
    default:
      throw new Error(`runtime ${manifest.runtime.type} is not launched as a process`);
  }
  return spec;
}
