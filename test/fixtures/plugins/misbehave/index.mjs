// A plugin written directly against HPP v1 (NDJSON JSON-RPC 2.0), without the SDK.
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
const result = (id, structuredContent) => send({ id, result: { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent } });
let config = {};
let nextId = 1;
const waiting = new Map();
const hostCall = (method, params) =>
  new Promise((resolve) => {
    const id = `p${nextId++}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "initialize": {
      config = msg.params.config ?? {};
      if (config.startup === "exit") process.exit(3);
      if (config.startup === "silent") return;
      if (config.startup === "garbage") process.stdout.write("hello from a stray console.log\n");
      const tools = ["echo", "crash", "throw_async", "hang", "slow", "oom", "escape", "env_dump", "host_call"].map((name) => ({ name }));
      if (config.startup === "undeclared") tools.push({ name: "sneaky" });
      send({ id: msg.id, result: { protocolVersion: config.startup === "badproto" ? 99 : 1, plugin: { sdk: "raw" }, registrations: { tools, hooks: [{ event: "tool.before" }] } } });
      return;
    }
    case "$/ping":
      return send({ id: msg.id, result: {} });
    case "shutdown":
      send({ id: msg.id, result: { ok: true } });
      setTimeout(() => process.exit(0), 5);
      return;
    case "config/didChange":
      config = msg.params.config ?? config;
      return;
    case "hook/invoke": {
      const mode = config.hookMode ?? "continue";
      if (mode === "throw") return send({ id: msg.id, error: { code: -32009, message: "hook exploded" } });
      if (mode === "slow") return;
      if (mode === "block") return send({ id: msg.id, result: { action: "block", reason: "blocked by misbehave", rule: "test_rule" } });
      if (mode === "modify")
        return send({ id: msg.id, result: { action: "modify", patch: [{ op: "replace", path: "/arguments/text", value: "patched" }], note: "patched by misbehave" } });
      return send({ id: msg.id, result: { action: "continue" } });
    }
    case "tool/call": {
      const { name, arguments: args } = msg.params;
      if (name === "echo") return result(msg.id, { echo: args, workspace: msg.params.session?.workspace ?? null });
      if (name === "crash") process.exit(1);
      if (name === "throw_async") return setTimeout(() => { throw new Error("boom"); }, 0);
      if (name === "hang") for (;;) {}
      if (name === "slow") return setTimeout(() => result(msg.id, { late: true }), 10_000);
      if (name === "oom") {
        const keep = [];
        for (;;) keep.push(new Array(1e6).fill(Math.random()));
      }
      if (name === "escape") {
        const out = {};
        const fs = await import("node:fs");
        try { fs.readFileSync("/etc/hosts", "utf8"); out.fs = "allowed"; } catch (e) { out.fs = e.code; }
        try { (await import("node:child_process")).spawnSync("ls"); out.spawn = "allowed"; } catch (e) { out.spawn = e.code; }
        try { await fetch("https://example.com"); out.fetch = "allowed"; } catch (e) { out.fetch = e.code ?? e.cause?.code ?? e.message; }
        return result(msg.id, out);
      }
      if (name === "env_dump") return result(msg.id, { keys: Object.keys(process.env).sort(), home: process.env.HOME });
      if (name === "host_call") {
        const r = await hostCall(args.method, args.params ?? {});
        return result(msg.id, r.error ? { error: r.error } : { result: r.result });
      }
      return send({ id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } });
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
});
