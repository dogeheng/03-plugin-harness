import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGINS_DIR = join(REPO, "plugins");
export const FIXTURES_DIR = join(REPO, "test", "fixtures", "plugins");

/** Polls until fn() is truthy (or throws after timeoutMs). */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, stepMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out${last ? `: ${(last as Error).message}` : ""}`);
}

/** rm -rf that also works on the read-only plugin store (dirs 0555, files 0444). */
export function forceRemove(dir: string): void {
  if (!existsSync(dir)) return;
  const visit = (d: string) => {
    try {
      chmodSync(d, 0o755);
    } catch {}
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) visit(join(d, e.name));
  };
  visit(dir);
  rmSync(dir, { recursive: true, force: true });
}

export function tempHome(prefix = "hx-test-"): { dir: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    env: { ...process.env, HARNESS_HOME: dir, HARNESS_SECRETS_BACKEND: "memory", HARNESS_PORT: "0", HARNESS_LOG_LEVEL: "warn" },
    cleanup: () => forceRemove(dir),
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

/** HTTP request with full control over headers (fetch cannot override Host). */
export function http(opts: {
  port?: number;
  socketPath?: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const req = request(
      {
        host: opts.socketPath ? undefined : "127.0.0.1",
        port: opts.socketPath ? undefined : opts.port,
        socketPath: opts.socketPath,
        path: opts.path,
        method: opts.method ?? "GET",
        headers: {
          ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
