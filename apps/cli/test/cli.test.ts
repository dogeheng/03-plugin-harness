import { execFile } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../test/helpers.ts";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BIN = join(ROOT, "bin", "harness");
const FAKE_KEY = `sk-or-v1-${"d4".repeat(32)}`;
let home: ReturnType<typeof tempHome>;

async function harness(args: string[], input?: string) {
  const p = run(BIN, args, { env: home.env, timeout: 30_000 });
  if (input !== undefined) {
    p.child.stdin?.end(input);
  }
  return p;
}

beforeAll(() => {
  home = tempHome("hx-cli-");
  writeFileSync(join(home.dir, "config.jsonc"), JSON.stringify({ model: { provider: "mock", id: "scripted" } }));
});

afterAll(async () => {
  await harness(["daemon", "stop"]).catch(() => {});
  home.cleanup();
});

describe("harness CLI", () => {
  it("auto-starts the daemon and reports status", async () => {
    const { stdout } = await harness(["daemon", "start"]);
    expect(stdout).toMatch(/harnessd 已启动|已在运行/);
    const status = JSON.parse((await harness(["status", "--json"])).stdout);
    expect(status).toMatchObject({ running: true, secretsBackend: "memory", model: { provider: "mock" } });
  });

  it("sends a one-shot chat message", async () => {
    const { stdout } = await harness(["chat", "第一次对话"]);
    expect(stdout).toContain("收到：第一次对话");
  });

  it("emits a raw NDJSON event stream with --json", async () => {
    const { stdout } = await harness(["chat", "--json", "事件流"]);
    const types = stdout.trim().split("\n").map((l) => JSON.parse(l).type);
    expect(types[0]).toBe("turn.start");
    expect(types).toContain("turn.end");
  });

  it("stores an API key from stdin without leaking it", async () => {
    const { stdout } = await harness(["auth", "set", "openrouter", "--stdin"], `${FAKE_KEY}\n`);
    expect(stdout).toContain("已把 openrouter 的 API Key 保存");
    expect(stdout).not.toContain(FAKE_KEY);
    const status = (await harness(["auth", "status"])).stdout;
    expect(status).toMatch(/● openrouter/);
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? scan(join(dir, d.name)) : d.name.endsWith(".sock") ? [] : [join(dir, d.name)]));
    for (const f of scan(home.dir)) expect(readFileSync(f).includes(FAKE_KEY), f).toBe(false);
  });

  it("switches models and lists sessions", async () => {
    expect((await harness(["model", "set", "mock", "scripted"])).stdout).toContain("mock / scripted");
    expect((await harness(["model", "show"])).stdout.trim()).toBe("mock / scripted");
    expect((await harness(["sessions"])).stdout).toContain("第一次对话");
  });

  it("prints a one-time login link", async () => {
    const { stdout } = await harness(["open", "--print"]);
    expect(stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback\?code=/);
  });

  it("stops the daemon", async () => {
    expect((await harness(["daemon", "stop"])).stdout).toContain("已停止");
    expect((await harness(["status"])).stdout).toContain("未在运行");
  });
});
