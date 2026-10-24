import { describe, expect, it } from "vitest";
import { command, definePlugin, ToolError, tool, z } from "../src/index.ts";
import { createMockHost } from "../src/testkit.ts";

const demo = definePlugin({
  tools: {
    greet: tool({
      input: z.object({ name: z.string().min(1) }).strict(),
      execute: async ({ name }, ctx) => ({ greeting: `hi ${name}`, workspace: ctx.workspace.root, config: ctx.config }),
    }),
    fail: tool({
      input: z.object({}),
      execute: async () => {
        throw new ToolError("not_found", "nothing here", { tried: 3 });
      },
    }),
    crashy: tool({
      input: z.object({}),
      execute: async () => {
        throw new TypeError("oops");
      },
    }),
    read: tool({
      input: z.object({ path: z.string() }),
      execute: async ({ path }, ctx) => ({ text: (await ctx.host.fs.read(path)).content }),
    }),
    remember: tool({
      input: z.object({ v: z.number() }),
      execute: async ({ v }, ctx) => {
        await ctx.host.storage.set("v", v);
        return { stored: await ctx.host.storage.get("v") };
      },
    }),
  },
  commands: { hello: command({ run: async (args) => ({ markdown: `# hello ${args.join(" ")}` }) }) },
  hooks: {
    "tool.before": async (payload) => {
      const p = payload as { name: string };
      return p.name === "danger" ? { action: "block", reason: "dangerous" } : { action: "continue" };
    },
  },
});

describe("plugin SDK", () => {
  it("registers tools, commands and hooks during the handshake", async () => {
    const h = await createMockHost(demo);
    expect(h.init.protocolVersion).toBe(1);
    expect(h.init.registrations.tools?.map((t) => t.name).sort()).toEqual(["crashy", "fail", "greet", "read", "remember"]);
    expect(h.init.registrations.commands?.map((c) => c.name)).toEqual(["hello"]);
    expect(h.init.registrations.hooks?.map((x) => x.event)).toEqual(["tool.before"]);
    await h.close();
  });

  it("validates input with zod and returns structured content", async () => {
    const h = await createMockHost(demo, { workspace: "/tmp/ws", config: { lang: "en" } });
    const ok = await h.callTool("greet", { name: "Ada" });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toEqual({ greeting: "hi Ada", workspace: "/tmp/ws", config: { lang: "en" } });
    // Invalid arguments are a protocol-level InvalidParams error naming the bad field.
    await expect(h.callTool("greet", { name: "" })).rejects.toMatchObject({ code: -32602, message: expect.stringContaining("/name") });
    await h.close();
  });

  it("turns ToolError into a model-readable error result", async () => {
    const h = await createMockHost(demo);
    const r = await h.callTool("fail");
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: "not_found", message: "nothing here", tried: 3 });
    await h.close();
  });

  it("reports unexpected exceptions as JSON-RPC errors instead of crashing", async () => {
    const h = await createMockHost(demo);
    await expect(h.callTool("crashy")).rejects.toMatchObject({ message: expect.stringContaining("oops") });
    expect((await h.callTool("greet", { name: "still alive" })).isError).toBeFalsy();
    await h.close();
  });

  it("surfaces host permission denials to the plugin", async () => {
    const h = await createMockHost(demo);
    await expect(h.callTool("read", { path: "/etc/hosts" })).rejects.toMatchObject({ message: expect.stringContaining("not granted") });
    const h2 = await createMockHost(demo, { handlers: { "host/fs.read": () => ({ content: "127.0.0.1 localhost", size: 19, truncated: false }) } });
    expect((await h2.callTool("read", { path: "/etc/hosts" })).structuredContent).toEqual({ text: "127.0.0.1 localhost" });
    expect(h2.calls.map((c) => c.method)).toEqual(["host/fs.read"]);
    await h.close();
    await h2.close();
  });

  it("uses host storage", async () => {
    const h = await createMockHost(demo);
    expect((await h.callTool("remember", { v: 42 })).structuredContent).toEqual({ stored: 42 });
    await h.close();
  });

  it("runs commands and hooks", async () => {
    const h = await createMockHost(demo);
    expect(await h.runCommand("hello", ["world"])).toMatchObject({ markdown: "# hello world" });
    expect(await h.invokeHook("tool.before", { name: "danger" })).toEqual({ action: "block", reason: "dangerous" });
    expect(await h.invokeHook("tool.before", { name: "safe" })).toEqual({ action: "continue" });
    await h.close();
  });
});
