import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../test/helpers.ts";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.ts";
import { migrate, openDatabase, SCHEMA_VERSION } from "../src/store/db.ts";
import { AuditRepo, SessionRepo, ToolCallRepo } from "../src/store/repos.ts";

const homes: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (homes.length) homes.pop()?.cleanup();
});

function db() {
  const h = tempHome();
  homes.push(h);
  return openDatabase(join(h.dir, "t.db"));
}

describe("database", () => {
  it("applies migrations once and is idempotent", () => {
    const d = db();
    expect(migrate(d)).toBe(SCHEMA_VERSION);
    expect(migrate(d)).toBe(SCHEMA_VERSION);
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["sessions", "messages", "plugins", "grants", "audit_events", "plugin_kv", "web_sessions"]));
  });

  it("stores sessions and ordered messages, cascading on delete", () => {
    const d = db();
    const repo = new SessionRepo(d);
    const s = repo.create("新会话", "/tmp/ws");
    repo.appendMessage(s.id, "user", { role: "user", content: "a" });
    repo.appendMessage(s.id, "assistant", { role: "assistant", content: [{ type: "text", text: "b" }] });
    const msgs = repo.messages(s.id);
    expect(msgs.map((m) => m.seq)).toEqual([1, 2]);
    expect(JSON.parse(msgs[1]?.content ?? "{}").role).toBe("assistant");
    repo.delete(s.id);
    expect(repo.messages(s.id)).toHaveLength(0);
  });

  it("redacts secrets in audit records and tool call logs", () => {
    const d = db();
    const fake = `sk-or-v1-${"b2".repeat(30)}`;
    const audit = new AuditRepo(d);
    audit.write({ kind: "net.fetch", target: `https://x.test/?key=${fake}`, decision: "deny", detail: { header: `Bearer ${fake}` } });
    const row = audit.list()[0];
    expect(JSON.stringify(row)).not.toContain(fake);
    const calls = new ToolCallRepo(d);
    calls.record({ id: "c1", sessionId: null, toolName: "t", pluginId: "p", input: { k: fake }, output: { v: fake }, status: "ok", startedAt: new Date().toISOString(), durationMs: 1 });
    expect(JSON.stringify(calls.recent("p"))).not.toContain(fake);
  });
});

describe("config", () => {
  it("returns defaults when the file is missing and round-trips changes", () => {
    const h = tempHome();
    homes.push(h);
    const file = join(h.dir, "config.jsonc");
    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG);
    const cfg = loadConfig(file);
    cfg.model = { provider: "mock", id: "scripted" };
    cfg.approvals.write = "auto";
    saveConfig(file, cfg);
    const back = loadConfig(file);
    expect(back.model).toEqual({ provider: "mock", id: "scripted" });
    expect(back.approvals.write).toBe("auto");
    expect(back.agent.maxSteps).toBe(DEFAULT_CONFIG.agent.maxSteps);
    expect(readFileSync(file, "utf8")).toMatch(/^\/\/ Harness configuration/);
  });
});
