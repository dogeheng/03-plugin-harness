import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PLUGINS_DIR } from "../../../test/helpers.ts";
import {
  checkSpawn,
  configDefaults,
  describeScope,
  isPrivateHost,
  loadAndValidate,
  matchHost,
  matchPath,
  normalizeSpawnScope,
  secretKeys,
  sensitiveReason,
  validateConfig,
  validateManifest,
} from "../src/index.ts";

const HOST = "0.1.0";
const base = () => ({
  id: "dev.example.hello",
  name: "Hello",
  version: "1.0.0",
  description: "demo",
  engines: { harness: ">=0.1.0" },
  runtime: { type: "node", entry: "index.mjs", protocol: [1] },
  contributes: { tools: [{ name: "hello", description: "say hi", risk: "read", inputSchema: { type: "object" } }] },
});
const codes = (r: { errors: Array<{ code: string }> }) => r.errors.map((e) => e.code);

const tmp = mkdtempSync(join(tmpdir(), "hx-manifest-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const r = validateManifest(base(), { hostVersion: HOST });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts the shipped git-insight manifest", () => {
    const r = loadAndValidate(join(PLUGINS_DIR, "git-insight"), HOST);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("reports schema errors with the JSON path", () => {
    const m = base() as Record<string, unknown>;
    delete m.name;
    m.version = "one";
    const r = validateManifest(m, { hostVersion: HOST });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes("name"))).toBe(true);
  });

  it("rejects ids that are not reverse-DNS", () => {
    const r = validateManifest({ ...base(), id: "Hello World" }, { hostVersion: HOST });
    expect(r.ok).toBe(false);
    expect(codes(r).some((c) => c === "invalid_id" || c === "schema")).toBe(true);
  });

  it("marks other host versions as incompatible (not invalid)", () => {
    const r = validateManifest({ ...base(), engines: { harness: ">=9.0.0" } }, { hostVersion: HOST });
    expect(r.ok).toBe(false);
    expect(r.incompatible).toBe(true);
    expect(codes(r)).toContain("incompatible_engine");
  });

  it("marks unsupported protocol versions as incompatible", () => {
    const r = validateManifest({ ...base(), runtime: { type: "node", entry: "index.mjs", protocol: [7] } }, { hostVersion: HOST });
    expect(r.incompatible).toBe(true);
    expect(codes(r)).toContain("incompatible_protocol");
  });

  it("rejects unknown permissions", () => {
    const r = validateManifest({ ...base(), permissions: { required: [{ id: "root.everything", reason: "needs everything" }] } }, { hostVersion: HOST });
    expect(codes(r)).toContain("unknown_permission");
  });

  it("rejects critical hooks without hooks.critical", () => {
    const r = validateManifest({ ...base(), contributes: { hooks: [{ event: "tool.before", critical: true }] } }, { hostVersion: HOST });
    expect(codes(r)).toContain("hook_permission");
  });

  it("panels must declare ui.panel; with it they validate", () => {
    const panels = [{ id: "timeline", title: "T", entry: "panel.html", location: "sidebar" as const }];
    const r = validateManifest({ ...base(), contributes: { panels } }, { hostVersion: HOST });
    expect(codes(r)).toContain("panel_permission");
    expect(r.errors.find((e) => e.code === "panel_permission")?.hint).toContain("ui.panel");
    const ok = validateManifest({ ...base(), contributes: { panels }, permissions: { required: [{ id: "ui.panel", reason: "show a panel" }] } }, { hostVersion: HOST });
    expect(codes(ok)).not.toContain("panel_permission");
  });

  it("rejects limits above the host ceiling", () => {
    const r = validateManifest({ ...base(), limits: { memoryMb: 4096 } }, { hostVersion: HOST });
    expect(codes(r)).toContain("limits");
  });

  it("rejects duplicate tool names", () => {
    const t = base().contributes.tools[0];
    const r = validateManifest({ ...base(), contributes: { tools: [t, t] } }, { hostVersion: HOST });
    expect(codes(r)).toContain("duplicate");
  });

  it("checks the entry file and path escapes when a directory is given", () => {
    const dir = join(tmp, "p1");
    mkdirSync(dir, { recursive: true });
    expect(codes(validateManifest(base(), { hostVersion: HOST, dir }))).toContain("missing_entry");
    const esc = validateManifest({ ...base(), runtime: { type: "node", entry: "../../etc/passwd", protocol: [1] } }, { hostVersion: HOST, dir });
    expect(codes(esc)).toContain("path_escape");
    writeFileSync(join(dir, "index.mjs"), "");
    expect(validateManifest(base(), { hostVersion: HOST, dir }).ok).toBe(true);
  });

  it("explains JSON syntax errors when loading from disk", () => {
    const dir = join(tmp, "p2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "harness.plugin.json"), '{ "id": "x", }}');
    const r = loadAndValidate(dir, HOST);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("parse_error");
  });
});

describe("path scopes", () => {
  const vars = { workspace: "/Users/me/proj", pluginData: "/data/p", home: "/Users/me" };
  it("expands ${workspace} and matches globs", () => {
    expect(matchPath(["${workspace}/**"], "/Users/me/proj/src/a.ts", vars)).toBe(true);
    expect(matchPath(["${workspace}/**"], "/Users/me/other/a.ts", vars)).toBe(false);
    expect(matchPath(["${workspace}/**/*.md"], "/Users/me/proj/docs/x.md", vars)).toBe(true);
    expect(matchPath(["${workspace}/**/*.md"], "/Users/me/proj/docs/x.ts", vars)).toBe(false);
  });
  it("never matches when the workspace is unknown", () => {
    expect(matchPath(["${workspace}/**"], "/anything", { ...vars, workspace: null })).toBe(false);
  });
  it("flags sensitive locations even inside granted scopes", () => {
    const data = "/Users/me/Library/Application Support/Harness";
    const c = { home: "/Users/me", harnessDirs: [data], ownPluginData: `${data}/plugins/data/dev.x.y` };
    expect(sensitiveReason("/Users/me/.ssh/id_ed25519", c)).toBeTruthy();
    expect(sensitiveReason("/Users/me/Library/Keychains/login.keychain-db", c)).toBeTruthy();
    expect(sensitiveReason(`${data}/harness.db`, c)).toBeTruthy();
    expect(sensitiveReason(`${data}/plugins/data/dev.other.plugin/x`, c)).toBeTruthy();
    expect(sensitiveReason(`${data}/plugins/data/dev.x.y/cache.json`, c)).toBeNull();
    expect(sensitiveReason("/Users/me/proj/README.md", c)).toBeNull();
  });
});

describe("host scopes", () => {
  it("matches exact hosts and subdomain wildcards over https", () => {
    expect(matchHost(["api.github.com"], new URL("https://api.github.com/repos"))).toBe(true);
    expect(matchHost(["*.github.com"], new URL("https://api.github.com/"))).toBe(true);
    expect(matchHost(["*.github.com"], new URL("https://evilgithub.com/"))).toBe(false);
    expect(matchHost(["api.github.com"], new URL("https://api.github.com.evil.io/"))).toBe(false);
  });
  it("treats loopback and private ranges as private", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.8", "192.168.1.2", "172.16.0.1", "169.254.169.254", "[::1]"]) expect(isPrivateHost(h)).toBe(true);
    expect(isPrivateHost("example.com")).toBe(false);
  });
  it("does not let * reach private hosts", () => {
    expect(matchHost(["*"], new URL("https://example.com/"))).toBe(true);
    expect(matchHost(["*"], new URL("http://127.0.0.1:8080/"))).toBe(false);
  });
});

describe("command scopes", () => {
  const rules = normalizeSpawnScope([{ cmd: "git", subcommands: ["status", "log", "diff"], denyArgs: ["-c", "--output", "--no-index"] }]);
  it("allows declared subcommands", () => {
    expect(checkSpawn(rules, "git", ["log", "-n5"]).ok).toBe(true);
  });
  it("rejects other commands, subcommands and global options before the subcommand", () => {
    expect(checkSpawn(rules, "rm", ["-rf", "/"]).ok).toBe(false);
    expect(checkSpawn(rules, "git", ["push"]).ok).toBe(false);
    expect(checkSpawn(rules, "git", ["-C", "/etc", "log"]).ok).toBe(false);
    expect(checkSpawn(rules, "/usr/bin/git", ["log"]).ok).toBe(false);
  });
  it("rejects denied arguments in both '--x' and '--x=value' forms", () => {
    expect(checkSpawn(rules, "git", ["diff", "--output", "/tmp/x"]).ok).toBe(false);
    expect(checkSpawn(rules, "git", ["diff", "--output=/tmp/x"]).ok).toBe(false);
    expect(checkSpawn(rules, "git", ["diff", "--no-index", "/etc/passwd", "/dev/null"]).ok).toBe(false);
  });
  it("describes scopes for review screens", () => {
    expect(describeScope("process.spawn", [{ cmd: "git", subcommands: ["log"] }])).toContain("git log");
    expect(describeScope("fs.read", ["${workspace}/**"])).toBe("工作区内的所有文件");
    expect(describeScope("net.fetch", ["*"])).toContain("不含本机和内网");
  });
});

describe("plugin settings", () => {
  const schema = {
    type: "object",
    properties: { max: { type: "integer", minimum: 1, default: 5 }, token: { type: "string", "x-secret": true }, lang: { enum: ["zh-CN", "en"], default: "en" } },
    required: ["token"],
  };
  it("extracts defaults and secret keys", () => {
    expect(configDefaults(schema)).toEqual({ max: 5, lang: "en" });
    expect(secretKeys(schema)).toEqual(["token"]);
  });
  it("validates values", () => {
    expect(validateConfig({ ...schema, required: [] }, { max: 3, lang: "en" })).toEqual([]);
    expect(validateConfig({ ...schema, required: [] }, { max: 0 }).length).toBeGreaterThan(0);
    expect(validateConfig({ ...schema, required: [] }, { lang: "fr" }).length).toBeGreaterThan(0);
  });
  it("ships an editor schema file", () => {
    const s = JSON.parse(readFileSync(join(PLUGINS_DIR, "..", "packages", "manifest", "schema", "harness.plugin.schema.json"), "utf8"));
    expect(s.$schema).toContain("2020-12");
  });
});
