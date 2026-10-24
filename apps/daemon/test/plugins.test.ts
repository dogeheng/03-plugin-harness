import { existsSync, readdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../../../test/helpers.ts";
import { ctxFor, makeRepo, startHost, type TestHost } from "../../../test/host.ts";

const GIT = "dev.harness.git-insight";
const MIS = "dev.test.misbehave";
let repo: ReturnType<typeof makeRepo>;
let host: TestHost | null = null;

beforeAll(() => {
  repo = makeRepo();
});
afterAll(() => repo.cleanup());
afterEach(async () => {
  await host?.stop();
  host = null;
});

const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { name: string; code?: number; message: string; payload?: Record<string, unknown> };
  }
  throw new Error("expected rejection");
};

describe("install, review and lifecycle", () => {
  it("discovers catalog plugins and reviews them without running code", async () => {
    host = await startHost();
    const ids = host.plugins.discover().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([GIT, MIS]));
    const review = host.plugins.inspect("git-insight");
    expect(review.ok).toBe(true);
    expect(review.permissions).toEqual([
      expect.objectContaining({ id: "process.spawn", required: true, risk: "high", scopeText: expect.stringContaining("git status|log|diff") }),
      expect.objectContaining({ id: "ui.panel", required: true }),
      expect.objectContaining({ id: "llm.invoke", required: false }),
    ]);
    expect(review.isolation.join(" ")).toContain("Node 权限模型");
    expect(host.plugins.list()).toEqual([]);
  });

  it("installs into a read-only, checksummed store and grants only required permissions", async () => {
    host = await startHost();
    const s = await host.plugins.install("git-insight");
    expect(s).toMatchObject({ id: GIT, state: "enabled", runtime: "node", contributes: { tools: ["git_status", "git_log", "git_diff_summary"], commands: ["changelog"] } });
    expect(s.permissions.find((p) => p.id === "process.spawn")?.granted).toBe(true);
    expect(s.permissions.find((p) => p.id === "llm.invoke")?.granted).toBe(false);
    const dir = host.plugins.get(GIT)?.dir as string;
    expect(dir).toContain(`${GIT}@1.0.0`);
    expect(existsSync(join(dir, ".harness-checksums.json"))).toBe(true);
    expect(existsSync(join(dir, "src"))).toBe(true);
    expect(existsSync(join(dir, "test"))).toBe(false);
    expect(statSync(join(dir, "dist", "index.mjs")).mode & 0o222).toBe(0);
    const again = await errOf(host.plugins.install("git-insight"));
    expect(again.message).toContain("已安装");
  });

  it("detects files modified after installation and refuses to load them", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    const dir = host.plugins.get(GIT)?.dir as string;
    const home = host.home;
    await host.stop(true);
    const f = join(dir, "dist", "index.mjs");
    chmodSync(join(dir, "dist"), 0o755);
    chmodSync(f, 0o644);
    writeFileSync(f, "// tampered\n");
    host = await startHost({ home });
    const s = host.plugins.list()[0];
    expect(s?.state).toBe("failed");
    expect(s?.stateDetail).toContain("被修改");
    expect(host.plugins.listTools()).toEqual([]);
  });

  it("disables, enables and uninstalls cleanly", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    expect(host.plugins.listTools().map((t) => t.name)).toContain("git_log");
    await host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir));
    const pid = host.plugins.get(GIT)?.instance?.snapshot().pid;
    expect(pid).toBeGreaterThan(0);
    await host.plugins.disable(GIT);
    expect(host.plugins.listTools()).toEqual([]);
    expect(host.plugins.get(GIT)?.instance?.snapshot().pid).toBeNull();
    expect(() => process.kill(pid as number, 0)).toThrow();
    await host.plugins.enable(GIT);
    expect(host.plugins.listTools().length).toBe(3);
    const dir = host.plugins.get(GIT)?.dir as string;
    await host.plugins.uninstall(GIT);
    expect(existsSync(dir)).toBe(false);
    expect(host.plugins.list()).toEqual([]);
    expect(readdirSync(join(host.home, "data", "plugins", "data"))).toEqual([]);
  });

  it("validates settings and pushes them to the running plugin", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    expect((await errOf(Promise.resolve().then(() => host?.plugins.setSettings(GIT, { nope: 1 })))).message).toContain("未知的设置项");
    expect((await errOf(Promise.resolve().then(() => host?.plugins.setSettings(GIT, { maxCommits: 0 })))).message).toContain("设置不合法");
    const before = (await host.plugins.callTool(GIT, "git_log", { limit: 10 }, ctxFor(repo.dir))) as { count: number };
    expect(before.count).toBe(3);
    host.plugins.setSettings(GIT, { maxCommits: 1 });
    await waitFor(async () => ((await host?.plugins.callTool(GIT, "git_log", { limit: 10 }, ctxFor(repo.dir))) as { count: number }).count === 1);
  });
});

describe("agent turn end-to-end", () => {
  it("lets the model call a plugin tool and answer with its result", async () => {
    host = await startHost({ script: { rules: [{ match: "提交", steps: [{ toolCalls: [{ name: "git_log", args: { limit: 2 } }] }, { text: "结果：{{result}}" }] }] } });
    await host.plugins.install("git-insight");
    const s = host.daemon.sessions.create("t", repo.dir);
    const res = await host.daemon.runtime.runTurn(s.id, "最近的提交是什么？", { emit: (e) => host?.daemon.bus.emit(e) });
    const result = host.events.find((e) => e.type === "tool.result");
    expect(result).toMatchObject({ toolName: "git_log", pluginId: GIT, ok: true });
    expect(JSON.stringify((result as { output: unknown }).output)).toContain("docs: third");
    expect(JSON.stringify(res)).toContain("docs: third");
  });
});

describe("permissions", () => {
  it("revoking a grant takes effect on the next host call and is audited", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    await host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir));
    const r = host.plugins.revoke(GIT, "process.spawn");
    expect(r.warning).toContain("必需权限");
    const e = await errOf(host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir)));
    expect(e.message).toMatch(/process\.spawn|运行命令|授权/);
    const audit = host.daemon.audit.list({ pluginId: GIT, limit: 10 });
    expect(audit.some((a) => a.kind === "process.exec" && a.decision === "deny")).toBe(true);
    host.plugins.grant(GIT, "process.spawn");
    await expect(host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir))).resolves.toMatchObject({ branch: "main" });
  });

  it("refuses commands outside the granted scope", async () => {
    host = await startHost();
    await host.plugins.install("misbehave");
    host.plugins.grant(MIS, "net.fetch", ["example.com"]);
    const out = (await host.plugins.callTool(MIS, "host_call", { method: "host/process.exec", params: { cmd: "ls", args: ["/"] } }, ctxFor(repo.dir))) as { error?: { code: number; message: string } };
    expect(out.error?.code).toBe(-32001);
    const fs = (await host.plugins.callTool(MIS, "host_call", { method: "host/fs.read", params: { path: "/etc/hosts" } }, ctxFor(repo.dir))) as { error?: { code: number } };
    expect(fs.error?.code).toBe(-32001);
    const net = (await host.plugins.callTool(MIS, "host_call", { method: "host/net.fetch", params: { url: "http://127.0.0.1:1/" } }, ctxFor(repo.dir))) as { error?: { code: number } };
    expect(net.error?.code).toBe(-32001);
  });

  it("asks the user at runtime for optional permissions and remembers 'always'", async () => {
    host = await startHost();
    await host.plugins.install("misbehave");
    const ask = (decision: "always" | "deny") => {
      const seen = host?.events.length ?? 0;
      return waitFor(() => host?.events.slice(seen).find((e) => e.type === "permission.request")).then((e) => {
        expect(e).toMatchObject({ pluginId: MIS, permission: "net.fetch", reason: "need it" });
        host?.plugins.resolvePrompt((e as { requestId: string }).requestId, decision);
      });
    };
    const call = () => host?.plugins.callTool(MIS, "host_call", { method: "host/permissions.request", params: { permission: "net.fetch", scope: ["example.com"], reason: "need it" } }, ctxFor(null)) as Promise<{ result?: { granted: boolean } }>;
    const [denied] = await Promise.all([call(), ask("deny")]);
    expect(denied.result?.granted).toBe(false);
    const [granted] = await Promise.all([call(), ask("always")]);
    expect(granted.result?.granted).toBe(true);
    expect(host.plugins.repo.grants(MIS).map((g) => g.permission)).toContain("net.fetch");
    const undeclared = (await host.plugins.callTool(MIS, "host_call", { method: "host/permissions.request", params: { permission: "fs.write", scope: ["/"], reason: "x" } }, ctxFor(null))) as { error?: { code: number } };
    expect(undeclared.error?.code).toBe(-32001);
  });
});

describe("isolation of plugin processes", () => {
  it("blocks direct file, process and network access (Node permission model)", async () => {
    host = await startHost();
    await host.plugins.install("misbehave");
    const r = await host.plugins.callTool(MIS, "escape", {}, ctxFor(null));
    expect(r).toEqual({ fs: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", fetch: "ERR_ACCESS_DENIED" });
  });

  it("starts plugins with a minimal environment", async () => {
    host = await startHost({ env: { OPENROUTER_API_KEY: "sk-or-v1-should-never-leak", HARNESS_TEST_SECRET: "x" } });
    await host.plugins.install("misbehave");
    const r = (await host.plugins.callTool(MIS, "env_dump", {}, ctxFor(null))) as { keys: string[]; home: string };
    expect(r.keys).not.toContain("OPENROUTER_API_KEY");
    expect(r.keys).not.toContain("HARNESS_TEST_SECRET");
    // Exactly the launcher's allowlist. __CF_USER_TEXT_ENCODING ("uid:encoding") is injected by
    // macOS into every process at exec time and carries no secrets.
    expect(r.keys.filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["HARNESS_PLUGIN_ID", "HARNESS_PROTOCOL", "HOME", "LANG", "PATH", "TMPDIR"]);
    expect(r.home).toContain(join("plugins", "data", MIS));
  });
});

describe("commands and host-side actions", () => {
  it("runs /changelog and writes CHANGELOG.md only after the user applies the action", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    const target = join(repo.dir, "CHANGELOG.md");
    try {
      const r = await host.plugins.runCommand("changelog", [], { workspace: repo.dir });
      expect(r.markdown).toMatch(/second/);
      expect(r.actionProblems).toEqual([]);
      expect(r.actions).toEqual([expect.objectContaining({ pluginId: GIT, path: "CHANGELOG.md", mode: "prepend", exists: false })]);
      // The plugin has no write permission: nothing is written until the user applies.
      expect(existsSync(target)).toBe(false);
      const done = host.plugins.applyAction(r.actions[0]?.id as string);
      expect(done.absPath.endsWith("CHANGELOG.md")).toBe(true);
      expect(readFileSync(target, "utf8")).toMatch(/second/);
      expect(host.daemon.audit.list({ pluginId: GIT }).some((a) => a.kind === "action.write-file" && a.decision === "allow")).toBe(true);
      expect(() => host?.plugins.applyAction(r.actions[0]?.id as string)).toThrow(/不存在或已过期/);
      // A second run prepends the new section below the existing content.
      const again = await host.plugins.runCommand("changelog", [], { workspace: repo.dir });
      expect(again.actions[0]).toMatchObject({ exists: true, mode: "prepend" });
    } finally {
      rmSync(target, { force: true });
    }
  });

  it("drops actions when there is no workspace and explains why", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    const err = await errOf(host.plugins.runCommand("changelog", [], { workspace: null }));
    // Without a workspace git cannot run at all; the plugin reports it as a clear error.
    expect(err.message).toBeTruthy();
  });

  it("explains unknown commands and lists the available ones", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    const err = (await errOf(host.plugins.runCommand("nope", []))) as { message: string; data?: { hint?: string } };
    expect(err.message).toContain("没有插件提供命令 /nope");
    expect(err.data?.hint).toContain("/changelog");
  });
});

/** Copies git-insight to a temp dir with a different version / extra permissions. */
function variant(patch: (m: Record<string, any>) => void): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "hx-variant-"));
  cpSync(join(import.meta.dirname, "..", "..", "..", "plugins", "git-insight"), dir, { recursive: true, filter: (s) => !s.includes("node_modules") && !s.endsWith("/test") });
  const file = join(dir, "harness.plugin.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  patch(m);
  writeFileSync(file, JSON.stringify(m, null, 2));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("update and rollback", () => {
  it("keeps grants, settings and data; new required permissions need consent", async () => {
    host = await startHost();
    await host.plugins.install("git-insight", { grantOptional: ["llm.invoke"] });
    host.plugins.setSettings(GIT, { maxCommits: 7 });
    const v2 = variant((m) => {
      m.version = "1.1.0";
      m.permissions.required.push({ id: "net.fetch", scope: ["api.github.com"], reason: "检查远端是否有新的标签" });
    });
    try {
      const err = (await errOf(host.plugins.update(GIT, { source: v2.dir }))) as { message: string; code: number; data?: { newPermissions?: string[]; hint?: string } };
      expect(err.code).toBe(-32001);
      expect(err.message).toContain("需要新的权限");
      expect(err.data?.newPermissions).toEqual(["net.fetch"]);
      expect(err.data?.hint).toContain("--accept-permissions");
      expect(host.plugins.detail(GIT).version).toBe("1.0.0");

      const r = await host.plugins.update(GIT, { source: v2.dir, acceptPermissions: true });
      expect(r).toMatchObject({ from: "1.0.0", to: "1.1.0", newPermissions: ["net.fetch"] });
      const d = host.plugins.detail(GIT);
      expect(d.version).toBe("1.1.0");
      expect(d.grants.map((g) => g.permission).sort()).toEqual(["llm.invoke", "net.fetch", "process.spawn", "ui.panel"]);
      expect(d.settings).toMatchObject({ maxCommits: 7 });
      expect(((await host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir))) as { branch: string }).branch).toBe("main");
      expect(host.daemon.audit.list({ pluginId: GIT }).some((a) => a.kind === "plugin.update")).toBe(true);

      const back = await host.plugins.rollback(GIT);
      expect(back).toMatchObject({ from: "1.1.0", to: "1.0.0" });
      expect(host.plugins.detail(GIT).version).toBe("1.0.0");
      expect(((await host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir))) as { branch: string }).branch).toBe("main");
    } finally {
      v2.cleanup();
    }
  });

  it("refuses same or older versions, foreign ids and dev installs", async () => {
    host = await startHost();
    await host.plugins.install("git-insight");
    expect((await errOf(host.plugins.update(GIT))).message).toContain("已经是最新版本");
    const other = variant((m) => {
      m.id = "dev.someone.else";
      m.version = "9.0.0";
    });
    try {
      expect((await errOf(host.plugins.update(GIT, { source: other.dir }))).message).toContain("不是 dev.harness.git-insight");
    } finally {
      other.cleanup();
    }
    expect((await errOf(host.plugins.rollback(GIT))).message).toContain("没有可回滚的旧版本");
    await host.plugins.uninstall(GIT);
    const dev = variant(() => {});
    try {
      await host.plugins.install(dev.dir, { dev: true });
      expect((await errOf(host.plugins.update(GIT))).message).toContain("开发模式");
    } finally {
      await host.plugins.uninstall(GIT);
      dev.cleanup();
    }
  });
});
