import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../test/helpers.ts";
import { makeRepo } from "../../../test/host.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BIN = join(ROOT, "bin", "harness");

let home: ReturnType<typeof tempHome>;
let repo: ReturnType<typeof makeRepo>;

/** Runs the real CLI non-interactively; never throws on a non-zero exit. */
function h(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(BIN, args, { env: { ...home.env, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 30_000 }, (err, stdout, stderr) => {
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });
}

beforeAll(() => {
  home = tempHome("hx-cli-plugins-");
  writeFileSync(join(home.dir, "config.jsonc"), JSON.stringify({ model: { provider: "mock", id: "scripted" } }));
  repo = makeRepo();
});
afterAll(async () => {
  await h(["daemon", "stop"]).catch(() => {});
  home.cleanup();
  repo.cleanup();
});

describe("harness plugin (end to end through the real CLI)", () => {
  it("lists the catalog and reviews a plugin before installing", async () => {
    const cat = await h(["plugin", "catalog"]);
    expect(cat.code).toBe(0);
    expect(cat.stdout).toContain("Git Insight");
    expect(cat.stdout).toContain("可安装");

    const review = await h(["plugin", "inspect", "git-insight"]);
    expect(review.code).toBe(0);
    expect(review.stdout).toContain("安装即授予的权限");
    expect(review.stdout).toContain("process.spawn");
    expect(review.stdout).toContain("可选权限");
    expect(review.stdout).toContain("llm.invoke");
    expect(review.stdout).toContain("独立进程");
  });

  it("requires --yes to install non-interactively, then installs", async () => {
    const refused = await h(["plugin", "install", "git-insight"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("非交互模式下安装需要加 --yes");

    const ok = await h(["plugin", "install", "git-insight", "--yes"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("已安装 Git Insight 1.0.0");
    expect(ok.stdout).toContain("harness run /changelog");

    const again = await h(["plugin", "install", "git-insight", "--yes"]);
    expect(again.code).toBe(1);
    expect(again.stdout).toContain("harness plugin update");

    const list = JSON.parse((await h(["plugin", "list", "--json"])).stdout) as { plugins: Array<{ id: string; enabled: boolean }> };
    expect(list.plugins).toEqual([expect.objectContaining({ id: "dev.harness.git-insight", enabled: true })]);
    expect((await h(["commands"])).stdout).toContain("/changelog");
  });

  it("runs a plugin command; file writes need --apply (or a yes in a terminal)", async () => {
    const target = join(repo.dir, "CHANGELOG.md");
    const dry = await h(["run", "/changelog", "--workspace", repo.dir]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/second/);
    expect(dry.stdout).toContain("未执行：写入 CHANGELOG.md");
    expect(existsSync(target)).toBe(false);

    const applied = await h(["run", "/changelog", "--workspace", repo.dir, "--apply"]);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain("已写入");
    expect(readFileSync(target, "utf8")).toMatch(/second/);
    rmSync(target);

    const unknown = await h(["run", "/nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("没有插件提供命令 /nope");
    expect(unknown.stderr).toContain("/changelog");
  });

  it("changes settings with validation", async () => {
    const set = await h(["plugin", "config", "git-insight", "maxCommits=50", "changelogLang=en"]);
    expect(set.code).toBe(0);
    expect(set.stdout).toContain("maxCommits = 50");
    const bad = await h(["plugin", "config", "git-insight", "maxCommits=0"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("设置不合法");
    const show = await h(["plugin", "config", "git-insight"]);
    expect(show.stdout).toContain("maxCommits = 50");
    expect(show.stdout).toContain("changelogLang");
  });

  it("revokes a permission with immediate effect; doctor explains the fix", async () => {
    const revoke = await h(["plugin", "revoke", "git-insight", "process.spawn"]);
    expect(revoke.code).toBe(0);
    expect(revoke.stdout).toContain("必需权限");

    const denied = await h(["run", "/changelog", "--workspace", repo.dir]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toMatch(/权限|授权/);
    expect(denied.stderr).toContain("harness plugin grant dev.harness.git-insight process.spawn");

    const doctor = await h(["plugin", "doctor"]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toContain("macOS Seatbelt 沙箱已启用");
    expect(doctor.stdout).toContain("缺少必需权限");
    expect(doctor.stdout).toContain("harness plugin grant dev.harness.git-insight process.spawn");

    expect((await h(["plugin", "grant", "git-insight", "process.spawn"])).code).toBe(0);
    expect((await h(["plugin", "doctor"])).stdout).toContain("没有发现问题");
    expect((await h(["run", "/changelog", "--workspace", repo.dir])).code).toBe(0);
  });

  it("disables and re-enables: contributions disappear and come back", async () => {
    expect((await h(["plugin", "disable", "git-insight"])).stdout).toContain("已禁用");
    expect((await h(["commands"])).stdout).toContain("没有可用的命令");
    expect((await h(["plugin", "enable", "git-insight"])).stdout).toContain("已启用");
    expect((await h(["commands"])).stdout).toContain("/changelog");
  });

  it("shows details, logs and the protocol trace", async () => {
    const info = await h(["plugin", "info", "git-insight"]);
    expect(info.code).toBe(0);
    expect(info.stdout).toContain("必需权限");
    expect(info.stdout).toContain("maxCommits = 50");
    expect(info.stdout).toContain("隔离");

    expect((await h(["plugin", "logs", "git-insight"])).code).toBe(0);
    await h(["run", "/changelog", "--workspace", repo.dir]);
    const trace = await h(["plugin", "trace", "git-insight"]);
    expect(trace.code).toBe(0);
    expect(trace.stdout).toContain("宿主 → 插件");
    expect(trace.stdout).toContain("command/run");

    const missing = await h(["plugin", "info", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("没有安装插件 nope");
  });

  it("uninstalls only with confirmation", async () => {
    const refused = await h(["plugin", "uninstall", "git-insight"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--yes");
    expect((await h(["plugin", "uninstall", "git-insight", "--yes"])).stdout).toContain("已卸载");
    expect((await h(["plugin", "list"])).stdout).toContain("还没有安装插件");
  });
});
