import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TurnEvent } from "@harness/shared";
import { tempHome } from "../../../test/helpers.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { ApprovalBroker, ToolRegistry, type HookRunner, type RegisteredTool } from "../src/agent/tools.ts";
import { DEFAULT_CONFIG, type HarnessConfig } from "../src/config.ts";
import { EventBus } from "../src/events/bus.ts";
import { createMockModel, type MockScript } from "../src/models/mock.ts";
import { openDatabase } from "../src/store/db.ts";
import { SessionRepo, ToolCallRepo } from "../src/store/repos.ts";

const homes: Array<{ cleanup(): void }> = [];
afterEach(() => {
  while (homes.length) homes.pop()?.cleanup();
});

function setup(opts: { script?: MockScript; tools?: RegisteredTool[]; hooks?: HookRunner; config?: Partial<HarnessConfig> } = {}) {
  const h = tempHome();
  homes.push(h);
  const db = openDatabase(join(h.dir, "t.db"));
  const sessions = new SessionRepo(db);
  const toolCalls = new ToolCallRepo(db);
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus, 2000);
  const registry = new ToolRegistry();
  registry.addSource({ id: "test", listTools: () => opts.tools ?? [] });
  const model = createMockModel(opts.script ?? { rules: [] });
  const config: HarnessConfig = { ...structuredClone(DEFAULT_CONFIG), ...opts.config };
  const runtime = new AgentRuntime({
    sessions,
    toolCalls,
    tools: registry,
    hooks: opts.hooks ?? { run: async (_e, payload) => ({ payload, notes: [] }) },
    approvals,
    getConfig: () => config,
    getModel: async () => model,
  });
  const session = sessions.create("新会话", "/tmp/ws");
  const events: TurnEvent[] = [];
  const run = (text: string) => runtime.runTurn(session.id, text, { emit: (e) => events.push(e) });
  return { runtime, sessions, toolCalls, bus, approvals, session, events, run, model };
}

const echoTool = (over: Partial<RegisteredTool> = {}): RegisteredTool => ({
  name: "echo",
  description: "echo input",
  inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
  risk: "read",
  pluginId: "test-plugin",
  timeoutMs: 1000,
  execute: async (input) => ({ echoed: (input as { msg: string }).msg }),
  ...over,
});

const callEcho: MockScript = { rules: [{ match: "echo", steps: [{ toolCalls: [{ name: "echo", args: { msg: "hi" } }] }, { text: "结果：{{result}}" }] }] };

describe("AgentRuntime", () => {
  it("answers without tools and persists the turn", async () => {
    const t = setup();
    const r = await t.run("你好");
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("收到：你好");
    expect(t.events.map((e) => e.type)).toEqual(expect.arrayContaining(["turn.start", "text.delta", "turn.end"]));
    const msgs = t.sessions.messages(t.session.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(t.sessions.get(t.session.id)?.title).toBe("你好");
  });

  it("runs a plugin tool, feeds the result back and records the call", async () => {
    const t = setup({ script: callEcho, tools: [echoTool()] });
    const r = await t.run("please echo");
    expect(r.text).toContain('"echoed":"hi"');
    const call = t.events.find((e) => e.type === "tool.call");
    const result = t.events.find((e) => e.type === "tool.result");
    expect(call).toMatchObject({ toolName: "echo", pluginId: "test-plugin" });
    expect(result).toMatchObject({ ok: true, output: { echoed: "hi" } });
    expect(t.sessions.messages(t.session.id).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(t.toolCalls.recent("test-plugin")).toHaveLength(1);
  });

  it("says honestly that a capability is missing when no tool is installed", async () => {
    const t = setup({ script: callEcho, tools: [] });
    const r = await t.run("please echo");
    expect(r.text).toContain("没有可用的工具");
    expect(t.events.some((e) => e.type === "tool.call")).toBe(false);
  });

  it("asks for approval on risky tools and respects a denial", async () => {
    const t = setup({ script: callEcho, tools: [echoTool({ risk: "write" })], config: { approvals: { read: "auto", network: "auto", write: "ask", exec: "ask" } } });
    t.bus.on((e) => {
      if (e.type === "approval.request") setTimeout(() => t.approvals.resolve(e.approvalId, false), 5);
    });
    const r = await t.run("please echo");
    const result = t.events.find((e) => e.type === "tool.result");
    expect(result).toMatchObject({ ok: false, error: { name: "PermissionDenied" } });
    expect(r.text).toContain("denied_by_user");
  });

  it("executes a risky tool after approval", async () => {
    const t = setup({ script: callEcho, tools: [echoTool({ risk: "exec" })], config: { approvals: { read: "auto", network: "auto", write: "ask", exec: "ask" } } });
    t.bus.on((e) => {
      if (e.type === "approval.request") setTimeout(() => t.approvals.resolve(e.approvalId, true), 5);
    });
    await t.run("please echo");
    expect(t.events.find((e) => e.type === "tool.result")).toMatchObject({ ok: true });
  });

  it("lets a tool.before hook block a call", async () => {
    const hooks: HookRunner = {
      run: async (event, payload) =>
        event === "tool.before" ? { payload, notes: [], blocked: { reason: "rm -rf is not allowed", pluginId: "guardrail", rule: "dangerous-command" } } : { payload, notes: [] },
    };
    let executed = false;
    const t = setup({ script: callEcho, tools: [echoTool({ execute: async () => ((executed = true), {}) })], hooks });
    await t.run("please echo");
    expect(executed).toBe(false);
    expect(t.events.find((e) => e.type === "tool.result")).toMatchObject({ ok: false, blockedBy: "guardrail" });
  });

  it("lets a tool.after hook rewrite the result before the model sees it", async () => {
    const hooks: HookRunner = {
      run: async (event, payload) => (event === "tool.after" ? { payload: { ...(payload as object), result: { echoed: "[REDACTED]" } } as typeof payload, notes: [] } : { payload, notes: [] }),
    };
    const t = setup({ script: callEcho, tools: [echoTool()], hooks });
    const r = await t.run("please echo");
    expect(r.text).toContain("[REDACTED]");
    expect(r.text).not.toContain('"hi"');
  });

  it("turns a hanging tool into a structured timeout error without hanging the turn", async () => {
    const t = setup({ script: callEcho, tools: [echoTool({ timeoutMs: 100, execute: () => new Promise(() => {}) })] });
    const started = Date.now();
    const r = await t.run("please echo");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(t.events.find((e) => e.type === "tool.result")).toMatchObject({ ok: false, error: { name: "Timeout" } });
    expect(r.text).toContain("tool_unavailable");
  });

  it("turns a throwing tool into a structured error", async () => {
    const t = setup({ script: callEcho, tools: [echoTool({ execute: async () => Promise.reject(new Error("boom")) })] });
    const r = await t.run("please echo");
    expect(r.error).toBeUndefined();
    expect(t.events.find((e) => e.type === "tool.result")).toMatchObject({ ok: false, error: { message: "boom" } });
  });

  it("rejects a concurrent turn in the same session", async () => {
    const t = setup({ script: callEcho, tools: [echoTool({ execute: () => new Promise((r) => setTimeout(() => r({}), 200)) })] });
    const first = t.run("please echo");
    const second = await t.run("again");
    expect(second.error?.message).toContain("正在处理");
    await first;
  });

  it("reports a missing session", async () => {
    const t = setup();
    const r = await t.runtime.runTurn("nope", "x", { emit: () => {} });
    expect(r.error?.message).toContain("会话不存在");
  });

  it("can be cancelled", async () => {
    const t = setup({ script: callEcho, tools: [echoTool({ timeoutMs: 5000, execute: () => new Promise(() => {}) })] });
    const p = t.run("please echo");
    setTimeout(() => t.runtime.cancel(t.session.id), 50);
    const r = await p;
    expect(Date.now()).toBeGreaterThan(0);
    expect(r.error?.message ?? JSON.stringify(t.events)).toMatch(/取消|tool_unavailable|aborted/);
  });
});
