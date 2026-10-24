import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths, sleep, type HarnessPaths } from "@harness/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const DAEMON_ENTRY = join(REPO_ROOT, "apps", "daemon", "src", "main.ts");

export interface DaemonInfo {
  pid: number;
  version: string;
  port: number;
  socketPath: string;
  token: string;
  startedAt: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function readDaemonInfo(paths: HarnessPaths): DaemonInfo | null {
  if (!existsSync(paths.daemonInfoFile)) return null;
  try {
    return JSON.parse(readFileSync(paths.daemonInfoFile, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class DaemonClient {
  readonly info: DaemonInfo;
  constructor(info: DaemonInfo) {
    this.info = info;
  }

  private raw(method: string, path: string, body?: unknown, accept = "application/json") {
    return new Promise<import("node:http").IncomingMessage>((resolveP, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath: this.info.socketPath,
          path,
          method,
          headers: {
            host: "localhost",
            authorization: `Bearer ${this.info.token}`,
            accept,
            ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}),
          },
        },
        resolveP,
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if ((res.statusCode ?? 500) >= 400) {
      const msg = (parsed as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.statusCode}`;
      throw new ApiError(res.statusCode ?? 500, msg, parsed);
    }
    return parsed as T;
  }

  /** POSTs and yields each NDJSON event line of the streamed response. */
  async *stream<T = Record<string, unknown>>(path: string, body: unknown): AsyncGenerator<T> {
    const res = await this.raw("POST", path, body, "application/x-ndjson");
    if ((res.statusCode ?? 500) >= 400) {
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      throw new ApiError(res.statusCode ?? 500, parsed?.error?.message ?? `HTTP ${res.statusCode}`, parsed);
    }
    let buf = "";
    for await (const chunk of res) {
      buf += (chunk as Buffer).toString("utf8");
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield JSON.parse(line) as T;
        i = buf.indexOf("\n");
      }
    }
  }
}

export async function healthy(info: DaemonInfo | null): Promise<boolean> {
  if (!info || !pidAlive(info.pid)) return false;
  try {
    const r = await new DaemonClient(info).json<{ ok: boolean }>("GET", "/api/health");
    return r.ok === true;
  } catch {
    return false;
  }
}

/** Returns a client for the running daemon, starting one in the background when needed. */
export async function ensureDaemon(opts: { env?: NodeJS.ProcessEnv; autoStart?: boolean; quiet?: boolean } = {}): Promise<DaemonClient> {
  const env = opts.env ?? process.env;
  const paths = resolvePaths(env);
  let info = readDaemonInfo(paths);
  if (await healthy(info)) return new DaemonClient(info as DaemonInfo);
  if (opts.autoStart === false) throw new Error("harnessd 未在运行。请运行 harness daemon start");
  await startDaemonProcess(env);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(120);
    info = readDaemonInfo(paths);
    if (await healthy(info)) return new DaemonClient(info as DaemonInfo);
  }
  throw new Error(`harnessd 启动超时。请查看日志：${paths.logsDir}/harnessd.out.log`);
}

export async function startDaemonProcess(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const paths = resolvePaths(env);
  mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  const out = openSync(join(paths.logsDir, "harnessd.out.log"), "a", 0o600);
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: ["ignore", out, out],
    env,
    cwd: REPO_ROOT,
  });
  child.unref();
  return child.pid ?? -1;
}
