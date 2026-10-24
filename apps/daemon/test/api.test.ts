import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { http, tempHome } from "../../../test/helpers.ts";
import { Daemon } from "../src/daemon.ts";
import { createMockModel } from "../src/models/mock.ts";
import { MemorySecretStore } from "../src/secrets/store.ts";

let daemon: Daemon;
let home: ReturnType<typeof tempHome>;
let port: number;
let token: string;
let socketPath: string;
const FAKE_KEY = `sk-or-v1-${"c3".repeat(32)}`;

beforeAll(async () => {
  home = tempHome();
  daemon = new Daemon({ env: home.env, port: 0, secrets: new MemorySecretStore(), modelFactory: async () => createMockModel(), webDist: null });
  ({ port, token, socketPath } = await daemon.start());
});

afterAll(async () => {
  await daemon.stop();
  home.cleanup();
});

const host = () => ({ host: `127.0.0.1:${port}` });
const bearer = () => ({ ...host(), authorization: `Bearer ${token}` });

async function login(): Promise<string> {
  const link = await http({ socketPath, path: "/api/auth/login-link", method: "POST", headers: { host: "localhost", authorization: `Bearer ${token}` } });
  const code = new URL(link.json<{ url: string }>().url).searchParams.get("code") ?? "";
  const cb = await http({ port, path: `/auth/callback?code=${encodeURIComponent(code)}`, headers: host() });
  expect(cb.status).toBe(302);
  const cookie = String(cb.headers["set-cookie"]).split(";")[0] ?? "";
  expect(String(cb.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Strict/);
  return cookie;
}

describe("local API security", () => {
  it("serves health without auth but requires auth elsewhere", async () => {
    expect((await http({ port, path: "/api/health", headers: host() })).status).toBe(200);
    expect((await http({ port, path: "/api/status", headers: host() })).status).toBe(401);
    expect((await http({ port, path: "/api/status", headers: bearer() })).status).toBe(200);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const r = await http({ port, path: "/api/health", headers: { host: "evil.example:80" } });
    expect(r.status).toBe(403);
    const r2 = await http({ port, path: "/api/status", headers: { host: `attacker.test:${port}`, authorization: `Bearer ${token}` } });
    expect(r2.status).toBe(403);
  });

  it("rejects cross-origin requests even with a valid token", async () => {
    const r = await http({ port, path: "/api/status", headers: { ...bearer(), origin: "http://evil.example" } });
    expect(r.status).toBe(403);
  });

  it("rejects a wrong bearer token", async () => {
    const r = await http({ port, path: "/api/status", headers: { ...host(), authorization: "Bearer nope" } });
    expect(r.status).toBe(401);
  });

  it("exposes login links only over the Unix socket", async () => {
    const r = await http({ port, path: "/api/auth/login-link", method: "POST", headers: bearer() });
    expect(r.status).toBe(404);
  });

  it("makes the Unix socket owner-only", () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(daemon.paths.daemonInfoFile).mode & 0o777).toBe(0o600);
  });

  it("exchanges a single-use login code for a session cookie", async () => {
    const link = await http({ socketPath, path: "/api/auth/login-link", method: "POST", headers: { host: "localhost", authorization: `Bearer ${token}` } });
    const code = new URL(link.json<{ url: string }>().url).searchParams.get("code") ?? "";
    expect((await http({ port, path: `/auth/callback?code=${code}`, headers: host() })).status).toBe(302);
    expect((await http({ port, path: `/auth/callback?code=${code}`, headers: host() })).status).toBe(401);
  });

  it("accepts cookie auth for GET and requires Origin for state changes", async () => {
    const cookie = await login();
    expect((await http({ port, path: "/api/status", headers: { ...host(), cookie } })).status).toBe(200);
    const noOrigin = await http({ port, path: "/api/sessions", method: "POST", headers: { ...host(), cookie }, body: {} });
    expect(noOrigin.status).toBe(403);
    const sameOrigin = await http({ port, path: "/api/sessions", method: "POST", headers: { ...host(), cookie, origin: `http://127.0.0.1:${port}` }, body: {} });
    expect(sameOrigin.status).toBe(201);
  });

  it("sets strict security headers", async () => {
    const r = await http({ port, path: "/api/status", headers: bearer() });
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(String(r.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });
});

describe("WebSocket events", () => {
  const connect = (headers: Record<string, string>) =>
    new Promise<{ ws: WebSocket; first: unknown } | { error: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers });
      ws.once("message", (d) => resolve({ ws, first: JSON.parse(String(d)) }));
      ws.once("unexpected-response", (_req, res) => resolve({ error: String(res.statusCode) }));
      ws.once("error", (e) => resolve({ error: e.message }));
    });

  it("rejects unauthenticated and cross-origin upgrades", async () => {
    expect(await connect({ host: `127.0.0.1:${port}` })).toMatchObject({ error: "401" });
    const cookie = await login();
    expect(await connect({ host: `127.0.0.1:${port}`, cookie, origin: "http://evil.example" })).toMatchObject({ error: "403" });
  });

  it("rejects malformed cookies without crashing the daemon", async () => {
    expect(await connect({ host: `127.0.0.1:${port}`, cookie: "harness_session=%ZZ" })).toMatchObject({ error: "401" });
    expect((await http({ port, path: "/api/status", headers: bearer() })).status).toBe(200);
  });

  it("streams turn events to an authenticated browser client", async () => {
    const cookie = await login();
    const res = await connect({ host: `127.0.0.1:${port}`, cookie, origin: `http://127.0.0.1:${port}` });
    if ("error" in res) throw new Error(res.error);
    const events: Array<{ type: string }> = [];
    res.ws.on("message", (d) => events.push(JSON.parse(String(d))));
    const s = (await http({ port, path: "/api/sessions", method: "POST", headers: bearer(), body: {} })).json<{ session: { id: string } }>();
    const accepted = await http({ port, path: `/api/sessions/${s.session.id}/messages`, method: "POST", headers: bearer(), body: { text: "hello ws" } });
    expect(accepted.status).toBe(202);
    for (let i = 0; i < 50 && !events.some((e) => e.type === "turn.end"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["turn.start", "text.delta", "turn.end"]));
    res.ws.close();
  });
});

describe("chat over the Unix socket", () => {
  it("streams NDJSON events for a turn", async () => {
    const s = (await http({ socketPath, path: "/api/sessions", method: "POST", headers: { host: "localhost", authorization: `Bearer ${token}` }, body: {} })).json<{
      session: { id: string };
    }>();
    const r = await http({
      socketPath,
      path: `/api/sessions/${s.session.id}/messages`,
      method: "POST",
      headers: { host: "localhost", authorization: `Bearer ${token}`, accept: "application/x-ndjson" },
      body: { text: "流式测试" },
    });
    const lines = r.text.trim().split("\n").map((l) => JSON.parse(l) as { type: string; text?: string });
    expect(lines[0]?.type).toBe("turn.start");
    expect(lines.at(-1)?.type).toBe("turn.end");
    expect(lines.filter((l) => l.type === "text.delta").map((l) => l.text).join("")).toBe("收到：流式测试");
    const detail = await http({ socketPath, path: `/api/sessions/${s.session.id}`, headers: { host: "localhost", authorization: `Bearer ${token}` } });
    expect(detail.json<{ messages: unknown[] }>().messages).toHaveLength(2);
  });
});

describe("secrets handling", () => {
  it("stores provider keys without echoing them anywhere", async () => {
    const r = await http({ port, path: "/api/providers/openrouter/key", method: "PUT", headers: bearer(), body: { apiKey: FAKE_KEY } });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(FAKE_KEY);
    const providers = await http({ port, path: "/api/providers", headers: bearer() });
    expect(providers.text).not.toContain(FAKE_KEY);
    expect(providers.json<{ providers: Array<{ id: string; configured: boolean }> }>().providers.find((p) => p.id === "openrouter")?.configured).toBe(true);
    // Force a log line that contains the key, then make sure every file on disk is clean.
    daemon.logger.warn({ apiKey: FAKE_KEY, note: `leak attempt ${FAKE_KEY}` }, `message with ${FAKE_KEY}`);
    daemon.logger.flush();
    await new Promise((r2) => setTimeout(r2, 200));
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? scan(join(dir, d.name)) : d.name.endsWith(".sock") ? [] : [join(dir, d.name)]));
    for (const f of scan(home.dir)) expect(readFileSync(f).includes(FAKE_KEY), f).toBe(false);
  });

  it("updates the model selection and persists it to config", async () => {
    const r = await http({ port, path: "/api/config/model", method: "PUT", headers: { ...bearer(), origin: `http://127.0.0.1:${port}` }, body: { provider: "openrouter", id: "openai/gpt-6-luna" } });
    expect(r.status).toBe(200);
    expect(readFileSync(daemon.paths.configFile, "utf8")).toContain("openai/gpt-6-luna");
  });
});
