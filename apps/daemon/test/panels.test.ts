import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIXTURES_DIR, forceRemove, http, PLUGINS_DIR } from "../../../test/helpers.ts";
import { makeRepo, startHost, type TestHost } from "../../../test/host.ts";

const PROBE = "dev.test.panel-probe";
const GIT = "dev.harness.git-insight";
const MIS = "dev.test.misbehave";

let host: TestHost | null = null;
afterEach(async () => {
  await host?.stop();
  host = null;
});

const panelGet = (path: string, headers: Record<string, string> = {}, method = "GET") => http({ port: host?.panels.port, path, headers, method });
const api = (method: string, path: string, body?: unknown) =>
  http({ port: host?.daemon.port, path, method, body, headers: { authorization: `Bearer ${host?.daemon.auth.token}` } });

describe("panel server: a separate, locked-down origin", () => {
  it("serves a declared panel from its own origin with a CSP that blocks all network access", async () => {
    host = await startHost();
    await host.plugins.install(join(FIXTURES_DIR, "panel-probe"));
    expect(host.panels.port).toBeGreaterThan(0);
    expect(host.panels.port).not.toBe(host.daemon.port);
    const r = await panelGet(`/${PROBE}/probe/`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.text).toContain("Isolation probe");
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("sandbox allow-scripts allow-forms");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain(`frame-ancestors http://127.0.0.1:${host.daemon.port} http://localhost:${host.daemon.port}`);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const js = await panelGet(`/${PROBE}/probe/probe.js`);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    // Without the trailing slash relative URLs would break: redirect.
    const noSlash = await panelGet(`/${PROBE}/probe`);
    expect(noSlash.status).toBe(308);
    expect(noSlash.headers.location).toBe(`/${PROBE}/probe/`);
  });

  it("the host UI may frame only the panel origin, and connect only to itself", async () => {
    host = await startHost();
    const r = await http({ port: host.daemon.port, path: "/api/health" });
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain(`frame-src http://127.0.0.1:${host.panels.port} http://localhost:${host.panels.port};`);
    expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${host.daemon.port} ws://localhost:${host.daemon.port};`);
    expect(csp).not.toContain(":*");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("rejects foreign Host headers (DNS rebinding) and non-GET methods", async () => {
    host = await startHost();
    await host.plugins.install(join(FIXTURES_DIR, "panel-probe"));
    expect((await panelGet(`/${PROBE}/probe/`, { host: "evil.example:80" })).status).toBe(403);
    expect((await panelGet(`/${PROBE}/probe/`, { host: `127.0.0.1:${host.daemon.port}` })).status).toBe(403);
    expect((await panelGet(`/${PROBE}/probe/`, { host: `localhost:${host.panels.port}` })).status).toBe(200);
    expect((await panelGet(`/${PROBE}/probe/`, {}, "POST")).status).toBe(405);
  });

  it("serves nothing outside the panel directory: traversal, encoded traversal and symlinks", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "hx-panel-"));
    const dir = join(tmp, "panel-probe");
    cpSync(join(FIXTURES_DIR, "panel-probe"), dir, { recursive: true });
    writeFileSync(join(tmp, "secret.txt"), "top secret");
    host = await startHost();
    await host.plugins.install(dir, { dev: true }); // dev install links the directory, so the symlink below is live
    symlinkSync(join(tmp, "secret.txt"), join(dir, "panel", "leak.txt"));
    for (const p of [
      `/${PROBE}/probe/../harness.plugin.json`,
      `/${PROBE}/probe/..%2Fharness.plugin.json`,
      `/${PROBE}/probe/%2e%2e/harness.plugin.json`,
      `/${PROBE}/probe/%2e%2e%2f%2e%2e%2fsecret.txt`,
      `/${PROBE}/probe/leak.txt`,
      `/${PROBE}/probe/nope.js`,
      `/${PROBE}/other/`,
      `/dev.test.not-installed/probe/`,
    ]) {
      const r = await panelGet(p);
      expect([403, 404], p).toContain(r.status);
      expect(r.text, p).not.toContain("top secret");
      expect(r.text, p).not.toContain('"runtime"');
    }
    forceRemove(tmp);
  });

  it("panels follow the plugin: disabled, ui.panel revoked or uninstalled => gone", async () => {
    host = await startHost();
    await host.plugins.install(join(FIXTURES_DIR, "panel-probe"));
    const listed = await api("GET", "/api/panels");
    const panels = listed.json<{ origin: string; panels: Array<{ pluginId: string; panelId: string; url: string }> }>();
    expect(panels.origin).toBe(`http://127.0.0.1:${host.panels.port}`);
    expect(panels.panels).toEqual([expect.objectContaining({ pluginId: PROBE, panelId: "probe", url: `http://127.0.0.1:${host.panels.port}/${PROBE}/probe/` })]);

    await host.plugins.disable(PROBE);
    expect((await panelGet(`/${PROBE}/probe/`)).status).toBe(404);
    expect((await api("GET", "/api/panels")).json<{ panels: unknown[] }>().panels).toEqual([]);

    await host.plugins.enable(PROBE);
    expect((await panelGet(`/${PROBE}/probe/`)).status).toBe(200);
    const rv = host.plugins.revoke(PROBE, "ui.panel");
    expect(rv.warning).toContain("必需权限");
    expect((await panelGet(`/${PROBE}/probe/`)).status).toBe(404);
    host.plugins.grant(PROBE, "ui.panel");
    expect((await panelGet(`/${PROBE}/probe/`)).status).toBe(200);

    await host.plugins.uninstall(PROBE);
    expect((await panelGet(`/${PROBE}/probe/`)).status).toBe(404);
  });
});

describe("panel bridge requests (relayed by the UI to /api/plugins/:id/panels/:panel/call)", () => {
  let repo: ReturnType<typeof makeRepo>;
  let misDir = "";
  beforeAll(() => {
    repo = makeRepo();
    // misbehave + a panel with tools.call, and one tool that has side effects
    misDir = join(mkdtempSync(join(tmpdir(), "hx-mispanel-")), "misbehave");
    cpSync(join(FIXTURES_DIR, "misbehave"), misDir, { recursive: true });
    const mf = JSON.parse(readFileSync(join(misDir, "harness.plugin.json"), "utf8"));
    mf.contributes.tools.find((t: { name: string }) => t.name === "echo").risk = "write";
    mf.contributes.panels = [{ id: "side", title: "Side", entry: "index.mjs", location: "sidebar", capabilities: ["tools.call"] }];
    mf.permissions.required = [...(mf.permissions.required ?? []), { id: "ui.panel", reason: "test" }];
    writeFileSync(join(misDir, "harness.plugin.json"), JSON.stringify(mf));
  });
  afterAll(() => {
    repo.cleanup();
    forceRemove(join(misDir, ".."));
  });

  it("the timeline panel reads commits through its own plugin's read-only tools", async () => {
    host = await startHost();
    await host.plugins.install(join(PLUGINS_DIR, "git-insight"));
    expect((await panelGet(`/${GIT}/timeline/`)).text).toContain("提交时间线");
    expect((await panelGet(`/${GIT}/timeline/main.js`)).status).toBe(200);
    const r = await api("POST", `/api/plugins/${GIT}/panels/timeline/call`, { method: "tools/call", params: { name: "git_log", arguments: { limit: 10 } }, workspace: repo.dir });
    expect(r.status, r.text).toBe(200);
    const out = r.json<{ ok: boolean; output: { commits: Array<{ subject: string }> } }>();
    expect(out.ok).toBe(true);
    expect(out.output.commits.map((c) => c.subject)).toEqual(["docs: third", "fix: second", "feat: first"]);
    const audit = host.daemon.audit.list({ pluginId: GIT, limit: 20 }).find((a) => a.kind === "panel.tools.call");
    expect(audit?.target).toBe("timeline → git_log");
  });

  it("a panel cannot call another plugin's tools, unknown methods, or tools without tools.call", async () => {
    host = await startHost();
    await host.plugins.install(join(PLUGINS_DIR, "git-insight"));
    await host.plugins.install(join(FIXTURES_DIR, "panel-probe"));
    const foreign = await api("POST", `/api/plugins/${GIT}/panels/timeline/call`, { method: "tools/call", params: { name: "echo" } });
    expect(foreign.status).toBe(403);
    expect(foreign.text).toContain("只能调用插件");
    const method = await api("POST", `/api/plugins/${GIT}/panels/timeline/call`, { method: "host/fs.read", params: { path: "/etc/hosts" } });
    expect(method.status).toBe(404);
    const noCap = await api("POST", `/api/plugins/${PROBE}/panels/probe/call`, { method: "tools/call", params: { name: "anything" } });
    expect(noCap.status).toBe(403);
    expect(noCap.text).toContain("tools.call");
    const missing = await api("POST", `/api/plugins/${GIT}/panels/nope/call`, { method: "tools/call", params: { name: "git_log" } });
    expect(missing.status).toBe(400);
  });

  it("tools with side effects need the user's confirmation", async () => {
    host = await startHost();
    await host.plugins.install(misDir);
    const ask = await api("POST", `/api/plugins/${MIS}/panels/side/call`, { method: "tools/call", params: { name: "echo", arguments: { x: 1 } } });
    expect(ask.status).toBe(403);
    expect(ask.json<{ error: { data: { needsConfirmation: boolean } } }>().error.data.needsConfirmation).toBe(true);
    const ok = await api("POST", `/api/plugins/${MIS}/panels/side/call`, { method: "tools/call", params: { name: "echo", arguments: { x: 1 } }, confirmed: true });
    expect(ok.status).toBe(200);
    expect(ok.json<{ ok: boolean; output: { echo: unknown } }>().ok).toBe(true);
  });
});
