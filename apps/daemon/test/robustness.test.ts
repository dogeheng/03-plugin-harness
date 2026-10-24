import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../../../test/helpers.ts";
import { ctxFor, makeRepo, startHost, type TestHost } from "../../../test/host.ts";

const MIS = "dev.test.misbehave";
const GIT = "dev.harness.git-insight";
let host: TestHost | null = null;
let repo: ReturnType<typeof makeRepo>;

beforeAll(() => {
  repo = makeRepo();
});
afterAll(() => repo.cleanup());
afterEach(async () => {
  await host?.stop();
  host = null;
});

const call = (name: string, args: unknown = {}) => host?.plugins.callTool(MIS, name, args, ctxFor(null)) as Promise<unknown>;
const errOf = async (p: Promise<unknown> | undefined) => {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string; hint?: string };
  }
  throw new Error("expected rejection");
};
const summary = () => host?.plugins.list().find((s) => s.id === MIS);
const instance = () => host?.plugins.get(MIS)?.instance;

async function withMode(settings: Record<string, string>) {
  host = await startHost();
  await host.plugins.install("misbehave");
  host.plugins.setSettings(MIS, settings);
  await instance()?.stop("idle");
}

describe("a misbehaving plugin cannot take the host down", () => {
  it("runs plugin processes inside the macOS Seatbelt sandbox", async () => {
    await withMode({});
    await call("echo", { text: "x" });
    const snap = instance()?.snapshot();
    expect(snap?.sandboxed).toBe(true);
    expect(snap?.isolation.join("\n")).toContain("macOS Seatbelt 沙箱");
    expect(host?.plugins.status().sandbox).toMatchObject({ mode: "seatbelt" });
  });
  it("a stop during activation wins: no process is left running, the next call starts cleanly", async () => {
    await withMode({});
    const inst = instance();
    const activation = inst?.ensureActive().catch((e: Error) => e);
    await inst?.stop("idle");
    await activation;
    expect(inst?.snapshot().pid).toBeNull();
    // A crash after the restart must still be explained and recovered from.
    const e = await errOf(call("crash"));
    expect(e.message).toContain("插件进程意外退出");
    await waitFor(() => instance()?.state === "active");
  });
  it("explains a crash during a call and restarts automatically", async () => {
    await withMode({});
    const e = await errOf(call("crash"));
    expect(e.message).toContain("插件进程意外退出（退出码 1）");
    expect(e.message).toContain("会自动重启");
    expect(host?.events.some((x) => x.type === "plugin.error" && x.pluginId === MIS && x.phase === "runtime")).toBe(true);
    await waitFor(() => instance()?.state === "active");
    await expect(call("echo", { text: "back" })).resolves.toMatchObject({ echo: { text: "back" } });
  });

  it("explains uncaught exceptions", async () => {
    await withMode({});
    expect((await errOf(call("throw_async"))).message).toContain("未捕获的异常并退出：Error: boom");
  });

  it("kills a plugin whose event loop is blocked (heartbeat)", async () => {
    await withMode({});
    const started = Date.now();
    const e = await errOf(call("hang"));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(e.message).toContain("心跳没有响应");
    await waitFor(() => instance()?.state === "active");
  });

  it("times out slow calls and restarts the process after repeated timeouts (circuit breaker)", async () => {
    await withMode({});
    host?.plugins.get(MIS)?.manifest.contributes?.tools?.forEach((t) => {
      if (t.name === "slow") t.timeoutMs = 150;
    });
    const first = instance()?.snapshot().stats.activations ?? 0;
    for (let i = 0; i < 3; i++) expect((await errOf(call("slow"))).message).toMatch(/超时|timed out/);
    await waitFor(() => (instance()?.snapshot().stats.activations ?? 0) > first && instance()?.state === "active");
    expect(host?.events.some((x) => x.type === "plugin.error" && x.phase === "call")).toBe(true);
  });

  it("enforces the memory limit from the manifest", async () => {
    await withMode({});
    const e = await errOf(call("oom"));
    expect(e.message).toContain("内存超过上限（64MB）");
  }, 20_000);

  it("quarantines a plugin that keeps failing, and recovers on enable", async () => {
    await withMode({ startup: "exit" });
    const e = await errOf(call("echo"));
    expect(e.message).toContain("退出码 3");
    await waitFor(() => summary()?.state === "quarantined", 5000);
    expect(summary()?.stateDetail).toContain("失败 3 次");
    expect(host?.plugins.listTools().some((t) => t.pluginId === MIS)).toBe(false);
    const blocked = await errOf(call("echo"));
    expect(blocked.message).toContain("quarantined");
    host?.plugins.setSettings(MIS, { startup: "ok" });
    await host?.plugins.enable(MIS);
    await expect(call("echo", { a: 1 })).resolves.toMatchObject({ echo: { a: 1 } });
  });

  it("reports a handshake timeout", async () => {
    await withMode({ startup: "silent" });
    const e = await errOf(call("echo"));
    expect(e.message).toContain("秒内没有完成握手");
  });

  it("refuses capabilities that were not declared in the manifest", async () => {
    await withMode({ startup: "undeclared" });
    const e = await errOf(call("echo"));
    expect(e.message).toContain("没有声明的能力：工具 sneaky");
  });

  it("marks protocol mismatches as incompatible and does not restart", async () => {
    await withMode({ startup: "badproto" });
    const e = await errOf(call("echo"));
    expect(e.message).toMatch(/协议|protocol/i);
    expect(summary()?.state).toBe("incompatible");
    const activations = instance()?.snapshot().stats.activations;
    await new Promise((r) => setTimeout(r, 300));
    expect(instance()?.snapshot().stats.activations).toBe(activations);
  });

  it("ignores stray stdout output and logs a hint", async () => {
    await withMode({ startup: "garbage" });
    await expect(call("echo", { ok: true })).resolves.toMatchObject({ echo: { ok: true } });
    expect(host?.plugins.logs(MIS, 50).join("\n")).toContain("stdout 非协议输出");
  });

  it("keeps other plugins working while one crashes", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    await host.plugins.install("misbehave");
    await errOf(call("crash"));
    await errOf(call("hang"));
    await expect(host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir))).resolves.toMatchObject({ branch: "main" });
  });
});

describe("hooks", () => {
  const script = { rules: [{ match: "echo", steps: [{ toolCalls: [{ name: "echo", args: { text: "orig" } }] }, { text: "done" }] }] };
  async function turn(settings: Record<string, string>, grants: string[] = []) {
    host = await startHost({ script });
    await host.plugins.install("misbehave");
    host.plugins.setSettings(MIS, settings);
    for (const g of grants) host.plugins.grant(MIS, g);
    const s = host.daemon.sessions.create("t", null);
    await host.daemon.runtime.runTurn(s.id, "echo please", { emit: (e) => host?.daemon.bus.emit(e) });
    return {
      result: host.events.find((e) => e.type === "tool.result") as { ok: boolean; output?: { echo?: { text: string } }; blockedBy?: string; error?: { message: string } },
      notices: host.events.filter((e) => e.type === "notice").map((e) => (e as { message: string }).message),
    };
  }

  it("blocks a tool call", async () => {
    const { result } = await turn({ hookMode: "block" });
    expect(result).toMatchObject({ ok: false, blockedBy: MIS, error: { message: "blocked by misbehave" } });
  });

  it("ignores modifications without session.modify and explains why", async () => {
    const { result, notices } = await turn({ hookMode: "modify" });
    expect(result.output?.echo?.text).toBe("orig");
    expect(notices.join("\n")).toContain("没有 session.modify 权限");
  });

  it("applies modifications when session.modify is granted", async () => {
    const { result, notices } = await turn({ hookMode: "modify" }, ["session.modify"]);
    expect(result.output?.echo?.text).toBe("patched");
    expect(notices).toContain("patched by misbehave");
  });

  it("skips a failing non-critical hook (fail-open)", async () => {
    const { result, notices } = await turn({ hookMode: "throw" });
    expect(result.ok).toBe(true);
    expect(notices.join("\n")).toContain("钩子出错（hook exploded），已跳过");
  });

  it("blocks when a critical hook fails (fail-closed)", async () => {
    const { result } = await turn({ hookMode: "throw" }, ["hooks.critical"]);
    expect(result).toMatchObject({ ok: false, blockedBy: MIS });
    expect(result.error?.message).toContain("为安全起见已暂停");
  });
});
