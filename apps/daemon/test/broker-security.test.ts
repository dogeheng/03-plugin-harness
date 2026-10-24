import type { LookupAddress } from "node:dns";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Resolver } from "../src/plugins/netguard.ts";
import { FIXTURES_DIR, forceRemove } from "../../../test/helpers.ts";
import { ctxFor, startHost, type TestHost } from "../../../test/host.ts";

const MIS = "dev.test.misbehave";
const SECRET = "sk-test-0123456789abcdef";

let server: Server;
let port = 0;
const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
let pluginDir = "";
let host: TestHost | null = null;

// "rebind.example" looks public but resolves to the local test server.
const fakeDns: Resolver = (h, cb) => {
  const table: Record<string, LookupAddress[]> = { "rebind.example": [{ address: "127.0.0.1", family: 4 }] };
  const r = table[h];
  if (r) cb(null, r);
  else cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: "ENOTFOUND" }), []);
};

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    if (req.url === "/redirect-away") {
      res.writeHead(302, { location: `http://localhost:${port}/landed` });
      return res.end();
    }
    if (req.url === "/leak") return res.end(`you sent ${req.headers.authorization}`);
    res.setHeader("set-cookie", "session=abc");
    res.end(JSON.stringify({ authorized: req.headers.authorization === `Bearer ${SECRET}` }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  // A copy of the misbehave fixture whose manifest names this test server literally.
  pluginDir = join(mkdtempSync(join(tmpdir(), "hx-brk-")), "misbehave");
  cpSync(join(FIXTURES_DIR, "misbehave"), pluginDir, { recursive: true });
  const mf = JSON.parse(readFileSync(join(pluginDir, "harness.plugin.json"), "utf8"));
  mf.permissions.optional = [
    ...mf.permissions.optional.filter((x: { id: string }) => x.id !== "net.fetch"),
    { id: "net.fetch", scope: ["*", `*:${port}`, `127.0.0.1:${port}`], reason: "test server" },
    { id: "fs.read", scope: ["${home}/**"], reason: "test: try to read sensitive files" },
    { id: "secrets.read", scope: ["apiKey"], reason: "test: plaintext access needs its own grant" },
  ];
  mf.configSchema.properties.apiKey = { type: "string", "x-secret": true };
  writeFileSync(join(pluginDir, "harness.plugin.json"), JSON.stringify(mf, null, 2));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  forceRemove(join(pluginDir, ".."));
});
afterEach(async () => {
  await host?.stop();
  host = null;
  seen.length = 0;
});

async function setup(grant: string[]) {
  host = await startHost({ plugins: { netResolver: fakeDns } });
  await host.plugins.install(pluginDir, { grantOptional: grant });
  await host.plugins.setSecret(MIS, "apiKey", SECRET);
  return host;
}
type HostCallResult = { result?: Record<string, unknown>; error?: { code: number; message: string; data?: Record<string, unknown> } };
const hostCall = (method: string, params: unknown) => host?.plugins.callTool(MIS, "host_call", { method, params }, ctxFor(null)) as Promise<HostCallResult>;
const audits = (kind: string) => host?.daemon.audit.list({ pluginId: MIS, limit: 50 }).filter((a) => a.kind === kind) ?? [];

describe("Broker: secrets are injected by the host, never handed to the plugin", () => {
  it("{{secret:apiKey}} is filled in on the way out and masked on the way back", async () => {
    await setup(["net.fetch"]);
    const ok = await hostCall("host/net.fetch", { url: `http://127.0.0.1:${port}/check`, headers: { authorization: "Bearer {{secret:apiKey}}" } });
    expect(JSON.parse(ok.result?.body as string)).toEqual({ authorized: true });
    expect(ok.result?.headers).not.toHaveProperty("set-cookie");
    const leak = await hostCall("host/net.fetch", { url: `http://127.0.0.1:${port}/leak`, headers: { authorization: "Bearer {{secret:apiKey}}" } });
    expect(leak.result?.body).toBe("you sent Bearer [REDACTED]");
    expect(JSON.stringify(leak)).not.toContain(SECRET);
    const allow = audits("net.fetch").filter((a) => a.decision === "allow");
    expect(allow.some((a) => JSON.parse(a.detail ?? "{}").secretInjected === true)).toBe(true);
    expect(JSON.stringify(host?.daemon.audit.list({ limit: 200 }))).not.toContain(SECRET);
  });

  it("a redirect to another host is re-checked and never carries the injected secret", async () => {
    await setup(["net.fetch"]);
    const r = await hostCall("host/net.fetch", { url: `http://127.0.0.1:${port}/redirect-away`, headers: { authorization: "Bearer {{secret:apiKey}}" } });
    expect(r.error?.message).toContain("没有被授权访问");
    expect(seen.map((s) => s.path)).toEqual(["/redirect-away"]);
    expect(audits("net.fetch").some((a) => a.decision === "deny" && JSON.parse(a.detail ?? "{}").hop === 1)).toBe(true);
  });

  it("a placeholder for an undeclared secret is refused before anything is sent", async () => {
    await setup(["net.fetch"]);
    const r = await hostCall("host/net.fetch", { url: `http://127.0.0.1:${port}/check`, headers: { authorization: "{{secret:OPENROUTER_API_KEY}}" } });
    expect(r.error?.message).toContain("没有在插件的 configSchema 中声明为 x-secret");
    expect(seen).toHaveLength(0);
  });

  it("reading the plaintext needs the separate secrets.read grant, and is audited either way", async () => {
    await setup(["net.fetch"]);
    const denied = await hostCall("host/secrets.read", { key: "apiKey" });
    expect(denied.error?.message).toContain("拿不到明文");
    expect(JSON.stringify(denied)).not.toContain(SECRET);
    host?.plugins.grant(MIS, "secrets.read");
    const allowed = await hostCall("host/secrets.read", { key: "apiKey" });
    expect(allowed.result?.value).toBe(SECRET);
    expect(audits("secrets.read").map((a) => a.decision)).toEqual(expect.arrayContaining(["deny", "allow"]));
  });
});

describe("Broker: network grants cannot be stretched to localhost or the LAN", () => {
  it("a broad grant (*) cannot reach a private literal address", async () => {
    await setup(["net.fetch"]);
    const r = await hostCall("host/net.fetch", { url: `http://localhost:${port}/x` });
    expect(r.error?.data).toMatchObject({ permission: "net.fetch" });
    const meta = await hostCall("host/net.fetch", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(meta.error?.message).toContain("没有被授权访问");
    expect(seen).toHaveLength(0);
  });

  it("DNS rebinding: a public-looking name that resolves to 127.0.0.1 is stopped at connect time", async () => {
    await setup(["net.fetch"]);
    const r = await hostCall("host/net.fetch", { url: `http://rebind.example:${port}/x` });
    expect(r.error?.message).toContain("解析到本机或内网地址 127.0.0.1");
    expect(r.error?.message).toContain("逐字声明");
    expect(seen).toHaveLength(0);
    expect(audits("net.fetch").some((a) => a.decision === "deny" && a.target?.includes("rebind.example"))).toBe(true);
  });
});

describe("Broker: sensitive locations stay closed even inside a granted scope", () => {
  it("fs.read of ~/.ssh is refused and audited although ${home}/** was granted", async () => {
    await setup(["fs.read"]);
    const target = join(homedir(), ".ssh", "id_ed25519");
    const r = await hostCall("host/fs.read", { path: target });
    expect(r.error?.message).toContain("始终禁止插件访问");
    const deny = audits("fs.read").find((a) => a.decision === "deny");
    expect(deny?.target).toContain(".ssh");
  });
});
