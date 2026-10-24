import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockHost } from "@harness/plugin-sdk/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import plugin, { buildChangelog, parseLog, parseNumstat, parseStatus } from "../src/index.ts";

let repo: string;
let notRepo: string;
const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z" } }).toString();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "hx-git-"));
  notRepo = mkdtempSync(join(tmpdir(), "hx-nogit-"));
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Ada");
  g("config", "user.email", "ada@example.com");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", ".");
  g("commit", "-qm", "feat: first feature");
  g("tag", "v0.1.0");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  g("add", ".");
  g("commit", "-qm", "fix(core): handle empty input");
  g("commit", "-q", "--allow-empty", "-m", "M1: plugin system");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  writeFileSync(join(repo, "new.txt"), "untracked\n");
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(notRepo, { recursive: true, force: true });
});

/** Mimics the host broker: runs the (already policy-checked) git command. */
const exec = (params: unknown) => {
  const p = params as { cmd: string; args: string[]; cwd?: string };
  const r = spawnSync(p.cmd, p.args, { cwd: p.cwd ?? repo, encoding: "utf8" });
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, truncated: false, durationMs: 1 };
};
const host = (workspace = repo, extra: Record<string, unknown> = {}) =>
  createMockHost(plugin, { workspace, config: { maxCommits: 200, changelogLang: "zh-CN", polish: true }, handlers: { "host/process.exec": exec, ...extra } as never });

describe("git-insight parsers", () => {
  it("parses porcelain v2 status", () => {
    const s = parseStatus(["# branch.oid abc", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1", "1 M. N... 100644 100644 100644 a b src/x.ts", "1 .M N... 100644 100644 100644 a b README.md", "? notes.txt"].join("\n"));
    expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, clean: false, untracked: ["notes.txt"] });
    expect(s.staged).toEqual([{ path: "src/x.ts", status: "modified" }]);
    expect(s.unstaged).toEqual([{ path: "README.md", status: "modified" }]);
  });
  it("parses numstat including binary files", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n")).toEqual({
      files: [
        { path: "src/a.ts", added: 3, deleted: 1, binary: false },
        { path: "logo.png", added: 0, deleted: 0, binary: true },
      ],
      totals: { files: 2, added: 3, deleted: 1 },
    });
  });
  it("groups conventional commits and keeps other subjects intact", () => {
    const md = buildChangelog(
      [
        { short: "a1", subject: "feat(ui): dark mode" },
        { short: "b2", subject: "fix: crash on start" },
        { short: "c3", subject: "feat!: new config format" },
        { short: "d4", subject: "M0: host skeleton" },
        { short: "e5", subject: "Merge branch 'x'" },
      ],
      { lang: "zh-CN", title: "测试" },
    );
    expect(md).toContain("### 破坏性变更\n\n- new config format (c3)");
    expect(md).toContain("### 新功能\n\n- **ui:** dark mode (a1)");
    expect(md).toContain("### 问题修复\n\n- crash on start (b2)");
    expect(md).toContain("- M0: host skeleton (d4)");
    expect(md).not.toContain("Merge branch");
  });
  it("parses log records", () => {
    expect(parseLog(`h1\x1fs1\x1fAda\x1f2026-10-01\x1ffeat: x\x1e\nh2\x1fs2\x1fBob\x1f2026-10-02\x1ffix: y\x1e`)).toEqual([
      { hash: "h1", short: "s1", author: "Ada", date: "2026-10-01", subject: "feat: x" },
      { hash: "h2", short: "s2", author: "Bob", date: "2026-10-02", subject: "fix: y" },
    ]);
  });
});

describe("git-insight against a real repository", () => {
  it("reports status", async () => {
    const h = await host();
    const r = await h.callTool("git_status");
    expect(r.structuredContent).toMatchObject({ branch: "main", clean: false, untracked: ["new.txt"], unstaged: [{ path: "a.txt", status: "modified" }] });
    await h.close();
  });

  it("lists commits with filters and respects maxCommits", async () => {
    const h = await host();
    const all = (await h.callTool("git_log", { limit: 10 })).structuredContent as { commits: Array<{ subject: string; author: string }>; count: number };
    expect(all.count).toBe(3);
    expect(all.commits[0]?.subject).toBe("M1: plugin system");
    const byPath = (await h.callTool("git_log", { path: "b.txt" })).structuredContent as { count: number };
    expect(byPath.count).toBe(1);
    await h.close();
    const capped = await createMockHost(plugin, { workspace: repo, config: { maxCommits: 1 }, handlers: { "host/process.exec": exec } as never });
    expect((await capped.callTool("git_log", { limit: 50 })).structuredContent).toMatchObject({ count: 1, note: expect.stringContaining("maxCommits") });
    await capped.close();
  });

  it("summarises diffs between revisions", async () => {
    const h = await host();
    const r = await h.callTool("git_diff_summary", { from: "v0.1.0" });
    expect(r.structuredContent).toMatchObject({ totals: { files: 2, added: 2, deleted: 0 } });
    await h.close();
  });

  it("rejects option injection in revisions and paths before running git", async () => {
    const h = await host();
    expect((await h.callTool("git_diff_summary", { from: "--output=/tmp/pwn" })).structuredContent).toMatchObject({ error: "invalid_revision" });
    await expect(h.callTool("git_log", { path: "--exec=sh" })).rejects.toMatchObject({ code: -32602 });
    expect(h.calls.filter((c) => JSON.stringify(c.params).includes("pwn"))).toEqual([]);
    await h.close();
  });

  it("explains non-repositories and unknown revisions", async () => {
    const h = await host(notRepo);
    expect((await h.callTool("git_status")).structuredContent).toMatchObject({ error: "not_a_repository" });
    await h.close();
    const h2 = await host();
    expect((await h2.callTool("git_diff_summary", { from: "v9.9.9" })).structuredContent).toMatchObject({ error: "unknown_revision" });
    await h2.close();
  });

  it("asks for a workspace when there is none", async () => {
    const h = await createMockHost(plugin, { workspace: null, handlers: { "host/process.exec": exec } as never });
    expect((await h.callTool("git_status")).structuredContent).toMatchObject({ error: "no_workspace" });
    await h.close();
  });

  it("/changelog uses the latest tag and offers a host-side write action", async () => {
    const h = await host();
    const r = await h.runCommand("changelog");
    expect(r.markdown).toContain("v0.1.0 之后的 2 个提交");
    expect(r.markdown).toContain("### 问题修复\n\n- **core:** handle empty input");
    expect(r.markdown).toContain("授予 Git Insight“调用模型”权限");
    expect(r.actions?.[0]).toMatchObject({ kind: "write-file", path: "CHANGELOG.md" });
    await h.close();
  });

  it("/changelog polishes with the model only when llm.invoke is granted", async () => {
    const h = await host(repo, { "host/llm.generate": () => ({ text: "## 润色后的版本\n\n- 更好用了 (abc)" }) });
    expect((await h.runCommand("changelog")).markdown).not.toContain("润色后的版本");
    await h.close();
    const granted = await createMockHost(plugin, {
      workspace: repo,
      grants: [{ permission: "llm.invoke" }],
      config: { polish: true },
      handlers: { "host/process.exec": exec, "host/llm.generate": () => ({ text: "## 润色后的版本\n\n- 更好用了 (abc)" }) } as never,
    });
    expect((await granted.runCommand("changelog")).markdown).toContain("润色后的版本");
    await granted.close();
  });
});
