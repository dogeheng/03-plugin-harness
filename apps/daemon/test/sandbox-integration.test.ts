import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandbox } from "../src/sandbox/seatbelt.ts";
import { forceRemove, PLUGINS_DIR, REPO } from "../../../test/helpers.ts";
import { ctxFor, makeRepo, startHost, type TestHost } from "../../../test/host.ts";

const GIT = "dev.harness.git-insight";
const SANDBOX_FIXTURES = join(REPO, "test", "fixtures", "sandbox");
let host: TestHost | null = null;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await host?.stop();
  host = null;
  for (const c of cleanups.splice(0)) await c();
});

const execAudit = (h: TestHost) =>
  h.daemon.audit
    .list({ pluginId: GIT, limit: 20 })
    .filter((a) => a.kind === "process.exec" && a.decision === "allow")
    .map((a) => JSON.parse(a.detail ?? "{}") as { sandboxed?: boolean; exitCode?: number });

describe("plugins under the macOS Seatbelt sandbox", () => {
  it("git runs sandboxed for a workspace inside the home directory (the workspace is put back)", async () => {
    // A fake home keeps the test away from the real one; the repo lives under it, like ~/Documents/project.
    const fakeHome = mkdtempSync(join(tmpdir(), "hx-sbint-home-"));
    const sandbox = createSandbox({ home: fakeHome });
    cleanups.push(async () => {
      await sandbox.dispose();
      forceRemove(fakeHome);
    });
    const repo = makeRepo(fakeHome);
    host = await startHost({ plugins: { sandbox } });
    expect(host.plugins.status().sandbox).toMatchObject({ mode: "seatbelt" });
    await host.plugins.install("git-insight");
    const st = (await host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir))) as { branch: string };
    expect(st.branch).toBe("main");
    const log = (await host.plugins.callTool(GIT, "git_log", { limit: 5 }, ctxFor(repo.dir))) as { commits: unknown[] };
    expect(log.commits).toHaveLength(3);
    const audits = execAudit(host);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.every((a) => a.sandboxed === true && a.exitCode === 0)).toBe(true);
    const snap = host.plugins.get(GIT)?.instance?.snapshot();
    expect(snap?.sandboxed).toBe(true);
  });
});

describe("sandbox switched off (HARNESS_SANDBOX=off)", () => {
  it("node plugins keep working, and every surface says the OS sandbox is off", async () => {
    const repo = makeRepo();
    cleanups.push(() => repo.cleanup());
    host = await startHost({ env: { HARNESS_SANDBOX: "off" } });
    expect(host.plugins.status().sandbox).toMatchObject({ mode: "off" });
    await host.plugins.install("git-insight");
    await expect(host.plugins.callTool(GIT, "git_status", {}, ctxFor(repo.dir))).resolves.toMatchObject({ branch: "main" });
    const snap = host.plugins.get(GIT)?.instance?.snapshot();
    expect(snap?.sandboxed).toBe(false);
    expect(snap?.isolation.join("\n")).toContain("OS 沙箱已关闭");
    expect(execAudit(host).every((a) => a.sandboxed === false)).toBe(true);
    const review = host.plugins.inspect(join(PLUGINS_DIR, "git-insight"));
    expect(review.isolation.join("\n")).toContain("OS 沙箱已关闭");
  });

  it("refuses to start a Python plugin, which has no in-process permission model", async () => {
    host = await startHost({ env: { HARNESS_SANDBOX: "off" }, plugins: { catalogDirs: [PLUGINS_DIR, SANDBOX_FIXTURES] } });
    await host.plugins.install("py-min");
    const err = await host.plugins.callTool("dev.test.py-min", "py_echo", {}, ctxFor(null)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("必须运行在 macOS Seatbelt 沙箱中");
    const review = host.plugins.inspect(join(SANDBOX_FIXTURES, "py-min"));
    expect(review.isolation.join("\n")).toContain("Python 插件在这种情况下无法运行");
  });
});
