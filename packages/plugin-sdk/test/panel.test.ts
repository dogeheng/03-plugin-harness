import { describe, expect, it } from "vitest";
import { type BridgeWindow, connectHost, type HostContext, PanelBridgeError } from "../src/panel.ts";

const CTX: HostContext = {
  theme: "dark",
  tokens: { bg: "#111", fg: "#eee" },
  workspace: "/tmp/repo",
  locale: "zh-CN",
  pluginId: "dev.x",
  panelId: "p",
  capabilities: ["tools.call"],
};

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown> };

/** A fake iframe window whose parent is a scripted host. */
function fakeWindow(onRequest: (m: Msg, reply: (r: { result?: unknown; error?: unknown }) => void) => void) {
  const listeners = new Set<(ev: { data: unknown; source: unknown }) => void>();
  const sent: Msg[] = [];
  const style: Record<string, string> = {};
  const dataset: Record<string, string | undefined> = {};
  const parent = {
    postMessage(message: unknown) {
      const m = message as Msg;
      sent.push(m);
      if (m.id === undefined) return;
      queueMicrotask(() =>
        onRequest(m, (r) => {
          for (const l of listeners) l({ data: { jsonrpc: "2.0", id: m.id, ...r }, source: parent });
        }),
      );
    },
  };
  const win: BridgeWindow = {
    parent,
    addEventListener: (_t, l) => listeners.add(l),
    removeEventListener: (_t, l) => listeners.delete(l),
    document: { documentElement: { style: { setProperty: (k, v) => void (style[k] = v) }, dataset } },
  };
  const fromParent = (data: unknown) => {
    for (const l of listeners) l({ data, source: parent });
  };
  const fromElsewhere = (data: unknown) => {
    for (const l of listeners) l({ data, source: {} });
  };
  return { win, sent, style, dataset, fromParent, fromElsewhere, listeners };
}

const standardHost = (m: Msg, reply: (r: { result?: unknown; error?: unknown }) => void) => {
  if (m.method === "ui/initialize") return reply({ result: { hostContext: CTX } });
  if (m.method === "tools/call") {
    if (m.params?.name === "boom") return reply({ error: { code: -32001, message: "denied", data: { needsConfirmation: true } } });
    return reply({ result: { ok: true, output: { echoed: m.params?.arguments } } });
  }
  if (m.method === "ui/open-link") return reply({ result: { opened: m.params?.url === "https://ok.example" } });
};

describe("panel SDK bridge", () => {
  it("initializes, applies theme tokens and announces readiness", async () => {
    const f = fakeWindow(standardHost);
    const host = await connectHost({ win: f.win });
    expect(host.context).toEqual(CTX);
    expect(f.sent[0]).toMatchObject({ method: "ui/initialize", params: { protocolVersion: "2026-01-26" } });
    expect(f.sent[1]).toMatchObject({ method: "ui/notifications/initialized" });
    expect(f.style["--hx-bg"]).toBe("#111");
    expect(f.style["color-scheme"]).toBe("dark");
    expect(f.dataset.theme).toBe("dark");
  });

  it("calls tools and surfaces host errors with their data", async () => {
    const f = fakeWindow(standardHost);
    const host = await connectHost({ win: f.win });
    await expect(host.callTool("git_log", { limit: 3 })).resolves.toEqual({ ok: true, output: { echoed: { limit: 3 } } });
    const err = await host.callTool("boom").catch((e) => e);
    expect(err).toBeInstanceOf(PanelBridgeError);
    expect(err).toMatchObject({ code: -32001, message: "denied", data: { needsConfirmation: true } });
    expect(await host.openLink("https://ok.example")).toBe(true);
    host.notify("hi", "success");
    expect(f.sent.at(-1)).toMatchObject({ method: "ui/notify", params: { message: "hi", level: "success" } });
  });

  it("ignores messages that do not come from the embedding parent", async () => {
    let replyLater: ((r: { result?: unknown }) => void) | null = null;
    const f = fakeWindow((m, reply) => {
      if (m.method === "ui/initialize") return reply({ result: { hostContext: CTX } });
      replyLater = reply;
    });
    const host = await connectHost({ win: f.win });
    const pending = host.callTool("x");
    await new Promise((r) => setTimeout(r, 5));
    // A forged response from another window (e.g. a nested frame) must not resolve the call.
    f.fromElsewhere({ jsonrpc: "2.0", id: 2, result: { ok: true, output: "forged" } });
    f.fromElsewhere({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { hostContext: { ...CTX, theme: "light" } } });
    expect(host.context.theme).toBe("dark");
    (replyLater as unknown as (r: { result?: unknown }) => void)({ result: { ok: true, output: "real" } });
    await expect(pending).resolves.toEqual({ ok: true, output: "real" });
  });

  it("follows host context changes", async () => {
    const f = fakeWindow(standardHost);
    const host = await connectHost({ win: f.win });
    const seen: string[] = [];
    host.onContextChange((c) => seen.push(c.theme));
    f.fromParent({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { hostContext: { ...CTX, theme: "light", tokens: { bg: "#fff" } } } });
    expect(seen).toEqual(["light"]);
    expect(host.context.theme).toBe("light");
    expect(f.style["--hx-bg"]).toBe("#fff");
  });

  it("times out when the host never answers, and refuses to run outside an iframe", async () => {
    const f = fakeWindow(() => {});
    await expect(connectHost({ win: f.win, timeoutMs: 50 })).rejects.toMatchObject({ code: -32002 });
    expect(f.listeners.size).toBe(0);
    const top = { addEventListener() {}, removeEventListener() {} } as unknown as BridgeWindow & { parent: unknown };
    (top as { parent: unknown }).parent = top;
    await expect(connectHost({ win: top })).rejects.toThrow(/iframe/);
  });
});
