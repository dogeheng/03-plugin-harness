import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import type { MockScript } from "../../apps/daemon/src/models/mock.ts";
import { FIXTURES_DIR, PLUGINS_DIR, REPO } from "../helpers.ts";
import { makeRepo, startHost, type TestHost } from "../host.ts";

export { expect };

/** The scripted model: deterministic tool calls so the UI flows are reproducible. */
export const SCRIPT: MockScript = {
  rules: [
    { match: "最近改了什么", steps: [{ toolCalls: [{ name: "git_log", args: { limit: 5 } }] }, { text: "仓库最近有 3 个提交，最新的是 **docs: third**。" }] },
    { match: "看看状态", steps: [{ toolCalls: [{ name: "git_status", args: {} }] }, { text: "工作区是干净的。" }] },
    { match: "崩溃", steps: [{ toolCalls: [{ name: "crash", args: {} }] }, { text: "那个插件崩溃了。" }] },
  ],
};

export const GIT_INSIGHT = "dev.harness.git-insight";
export const PROBE = "dev.test.panel-probe";
export const MISBEHAVE = "dev.test.misbehave";
export const pluginSource = { gitInsight: join(PLUGINS_DIR, "git-insight"), probe: join(FIXTURES_DIR, "panel-probe"), misbehave: join(FIXTURES_DIR, "misbehave") };

export interface Harness {
  host: TestHost;
  base: string;
  repo: string;
  /** Requests that tried to leave 127.0.0.1 (all are aborted). */
  leaks: string[];
  /** Uncaught errors in the main UI. */
  pageErrors: string[];
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  install(source: string, opts?: { grantOptional?: string[] }): Promise<void>;
  login(page: Page, path?: string): Promise<void>;
}

const LOCAL = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

export const test = base.extend<{ harness: Harness }>({
  harness: async ({ page }, use) => {
    const repo = makeRepo();
    const host = await startHost({ script: SCRIPT, webDist: join(REPO, "apps", "web", "dist"), plugins: { promptTimeoutMs: 60_000 } });
    const baseUrl = `http://127.0.0.1:${host.daemon.port}`;
    const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
      const r = await fetch(baseUrl + path, {
        method,
        headers: { authorization: `Bearer ${host.daemon.auth.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
      return (text ? JSON.parse(text) : null) as T;
    };
    await api("PATCH", "/api/config", { workspace: repo.dir });

    const leaks: string[] = [];
    const pageErrors: string[] = [];
    await page.context().route(
      (url) => /^(https?|wss?):$/.test(url.protocol) && !LOCAL.test(url.href),
      (route) => {
        leaks.push(route.request().url());
        return route.abort("blockedbyclient");
      },
    );
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    await use({
      host,
      base: baseUrl,
      repo: repo.dir,
      leaks,
      pageErrors,
      api,
      install: async (source, opts = {}) => {
        await api("POST", "/api/plugins/install", { source, enable: true, grantOptional: opts.grantOptional ?? [] });
      },
      login: async (p, path = "/") => {
        const code = host.daemon.auth.mintLoginCode();
        await p.goto(`${baseUrl}/auth/callback?code=${encodeURIComponent(code)}`);
        await expect(p.getByTestId("status-bar")).toContainText("已连接");
        if (path !== "/") await p.goto(baseUrl + path);
      },
    });

    try {
      expect(pageErrors, "main UI threw uncaught errors").toEqual([]);
    } finally {
      await host.stop();
      repo.cleanup();
    }
  },
});
