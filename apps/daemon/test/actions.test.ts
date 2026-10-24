import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "@harness/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActionStore, prependUnderTitle } from "../src/plugins/actions.ts";
import { forceRemove } from "../../../test/helpers.ts";

let ws: string;
let outside: string;
let home: string;
let store: ActionStore;

const write = (path: string, content = "x", mode?: "create" | "overwrite" | "prepend") => ({ id: "a", label: "写入", kind: "write-file" as const, path, content, mode });

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "hx-ws-"));
  outside = mkdtempSync(join(tmpdir(), "hx-out-"));
  home = mkdtempSync(join(tmpdir(), "hx-home-"));
  store = new ActionStore(resolvePaths({ HARNESS_HOME: home }), { home });
});
afterEach(() => {
  for (const d of [ws, outside, home]) forceRemove(d);
});

describe("ActionStore.register", () => {
  it("accepts workspace-relative paths and describes the action", () => {
    writeFileSync(join(ws, "CHANGELOG.md"), "# Changelog\n");
    const { views, problems } = store.register("p", ws, [write("CHANGELOG.md", "## 1.0\n", "prepend"), write("docs/new.md", "hi")]);
    expect(problems).toEqual([]);
    expect(views).toEqual([
      expect.objectContaining({ pluginId: "p", path: "CHANGELOG.md", mode: "prepend", exists: true, bytes: 7 }),
      expect.objectContaining({ path: join("docs", "new.md"), mode: "create", exists: false }),
    ]);
    expect(views[0].id).toMatch(/^act_[0-9a-f]{12}$/);
    // The content itself is not echoed back except as a bounded preview.
    expect(views[0]).not.toHaveProperty("content");
  });

  it.each([
    ["/etc/hosts", "相对路径"],
    ["../escape.txt", ".."],
    ["a/../../escape.txt", ".."],
    [".git/config", ".git"],
    ["", "路径无效"],
  ])("rejects %s", (path, reason) => {
    const { views, problems } = store.register("p", ws, [write(path)]);
    expect(views).toEqual([]);
    expect(problems[0]).toContain(reason);
  });

  it("rejects paths that escape through a symlinked directory or file", () => {
    symlinkSync(outside, join(ws, "link"));
    writeFileSync(join(outside, "target.txt"), "secret");
    symlinkSync(join(outside, "target.txt"), join(ws, "file-link.txt"));
    const { problems } = store.register("p", ws, [write("link/x.txt"), write("file-link.txt", "x", "overwrite")]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("符号链接");
    expect(problems[1]).toContain("符号链接");
  });

  it("needs a workspace and valid content", () => {
    expect(store.register("p", null, [write("a.txt")]).problems[0]).toContain("需要工作区");
    expect(store.register("p", ws, [{ ...write("a.txt"), content: 42 as unknown as string }]).problems[0]).toContain("内容无效");
    expect(store.register("p", ws, [{ ...write("a.txt"), kind: "run-shell" as "write-file" }]).problems[0]).toContain("不支持的动作类型");
  });

  it("refuses sensitive locations even inside the workspace", () => {
    // A workspace that is the home directory must not allow writing ~/.ssh.
    const s = new ActionStore(resolvePaths({ HARNESS_HOME: join(home, ".harness-data") }), { home: ws });
    mkdirSync(join(ws, ".ssh"));
    expect(s.register("p", ws, [write(".ssh/authorized_keys")]).problems[0]).toBeTruthy();
  });
});

describe("ActionStore.apply", () => {
  it("creates, overwrites and prepends below the title", () => {
    writeFileSync(join(ws, "CHANGELOG.md"), "# Changelog\n\n## 0.9\n- old\n");
    writeFileSync(join(ws, "out.txt"), "old");
    const { views } = store.register("p", ws, [write("CHANGELOG.md", "## 1.0\n- new\n", "prepend"), write("out.txt", "new", "overwrite"), write("sub/dir/n.txt", "n")]);
    for (const v of views) store.apply(v.id);
    expect(readFileSync(join(ws, "CHANGELOG.md"), "utf8")).toBe("# Changelog\n\n## 1.0\n- new\n\n## 0.9\n- old\n");
    expect(readFileSync(join(ws, "out.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(ws, "sub", "dir", "n.txt"), "utf8")).toBe("n");
  });

  it("refuses to overwrite in create mode", () => {
    writeFileSync(join(ws, "a.txt"), "keep");
    const { views } = store.register("p", ws, [write("a.txt", "new")]);
    expect(() => store.apply(views[0].id)).toThrow(/已存在/);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("keep");
  });

  it("is single use", () => {
    const { views } = store.register("p", ws, [write("once.txt", "1")]);
    store.apply(views[0].id);
    expect(() => store.apply(views[0].id)).toThrow(/不存在或已过期/);
  });

  it("expires pending actions", async () => {
    const s = new ActionStore(resolvePaths({ HARNESS_HOME: home }), { home, ttlMs: 5 });
    const { views } = s.register("p", ws, [write("late.txt")]);
    await new Promise((r) => setTimeout(r, 20));
    expect(() => s.apply(views[0].id)).toThrow(/过期/);
    expect(existsSync(join(ws, "late.txt"))).toBe(false);
  });

  it("re-checks the target right before writing (symlink swapped in later)", () => {
    const { views } = store.register("p", ws, [write("later/x.txt")]);
    symlinkSync(outside, join(ws, "later"));
    expect(() => store.apply(views[0].id)).toThrow(/符号链接/);
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });
});

describe("prependUnderTitle", () => {
  it("keeps a leading title and handles files without one", () => {
    expect(prependUnderTitle("# T\n\nold\n", "## new")).toBe("# T\n\n## new\n\nold\n");
    expect(prependUnderTitle("old\n", "## new\n")).toBe("## new\n\nold\n");
    expect(prependUnderTitle("# T\n", "# Own title\nbody")).toBe("# Own title\nbody\n\n# T\n");
  });
});
