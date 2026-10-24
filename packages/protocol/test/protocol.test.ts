import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { applyPatch, MAX_FRAME_BYTES, ndjsonTransport, RpcError, RpcErrorCode, RpcPeer } from "../src/index.ts";

function pair(opts: { onInvalidLine?: (l: string) => void } = {}) {
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const a = new RpcPeer(ndjsonTransport(b2a, a2b));
  const b = new RpcPeer(ndjsonTransport(a2b, b2a), { onInvalidLine: opts.onInvalidLine });
  return { a, b, a2b, b2a };
}

describe("RpcPeer", () => {
  it("round-trips requests in both directions", async () => {
    const { a, b } = pair();
    b.handle("add", (p) => (p as { x: number; y: number }).x + (p as { x: number; y: number }).y);
    a.handle("whoami", () => "a");
    expect(await a.request("add", { x: 2, y: 3 })).toBe(5);
    expect(await b.request("whoami", {})).toBe("a");
  });

  it("maps thrown RpcErrors and unknown methods", async () => {
    const { a, b } = pair();
    b.handle("deny", () => {
      throw new RpcError(RpcErrorCode.PermissionDenied, "nope", { permission: "fs.read" });
    });
    await expect(a.request("deny", {})).rejects.toMatchObject({ code: RpcErrorCode.PermissionDenied, message: "nope", data: { permission: "fs.read" } });
    await expect(a.request("missing", {})).rejects.toMatchObject({ code: RpcErrorCode.MethodNotFound });
  });

  it("times out and sends $/cancelRequest so the handler can stop", async () => {
    const { a, b } = pair();
    let aborted = false;
    b.handle("slow", (_p, ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => ((aborted = true), resolve(null)))));
    await expect(a.request("slow", {}, { timeoutMs: 50 })).rejects.toMatchObject({ code: RpcErrorCode.Timeout });
    await new Promise((r) => setTimeout(r, 30));
    expect(aborted).toBe(true);
  });

  it("cancels via AbortSignal", async () => {
    const { a, b } = pair();
    b.handle("slow", () => new Promise(() => {}));
    const ac = new AbortController();
    const p = a.request("slow", {}, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: RpcErrorCode.Cancelled });
  });

  it("delivers progress notifications", async () => {
    const { a, b } = pair();
    b.handle("work", async (_p, ctx) => {
      ctx.progress({ pct: 50 });
      ctx.progress({ pct: 100 });
      return "done";
    });
    const seen: unknown[] = [];
    expect(await a.request("work", {}, { onProgress: (v) => seen.push(v) })).toBe("done");
    expect(seen).toEqual([{ pct: 50 }, { pct: 100 }]);
  });

  it("reports non-protocol stdout lines without failing", async () => {
    const bad: string[] = [];
    const { a, b, a2b } = pair({ onInvalidLine: (l) => bad.push(l) });
    b.handle("ping", () => "pong");
    a2b.write("hello from console.log\n");
    expect(await a.request("ping", {})).toBe("pong");
    expect(bad).toEqual(["hello from console.log"]);
  });

  it("handles many concurrent requests", async () => {
    const { a, b } = pair();
    b.handle("sq", async (p) => {
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      return (p as number) ** 2;
    });
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => a.request("sq", i)));
    expect(out).toEqual(Array.from({ length: 50 }, (_, i) => i * i));
  });

  it("rejects pending requests when the connection closes", async () => {
    const { a, b, b2a } = pair();
    b.handle("never", () => new Promise(() => {}));
    const p = a.request("never", {});
    b2a.end();
    await expect(p).rejects.toBeInstanceOf(RpcError);
    expect(a.closed).toBe(true);
  });

  it("refuses frames above the size limit", async () => {
    const { a, b } = pair();
    b.handle("big", () => "x".repeat(MAX_FRAME_BYTES + 10));
    await expect(a.request("big", {}, { timeoutMs: 2000 })).rejects.toBeInstanceOf(RpcError);
  });
});

describe("applyPatch", () => {
  it("replaces, adds and removes without mutating the input", () => {
    const doc = { arguments: { text: "hi", n: 1 }, list: [1, 2] };
    const out = applyPatch(doc, [
      { op: "replace", path: "/arguments/text", value: "patched" },
      { op: "add", path: "/arguments/extra", value: true },
      { op: "remove", path: "/arguments/n" },
      { op: "add", path: "/list/-", value: 3 },
    ]);
    expect(out).toEqual({ arguments: { text: "patched", extra: true }, list: [1, 2, 3] });
    expect(doc.arguments.text).toBe("hi");
  });
  it("rejects paths that do not exist and prototype pollution", () => {
    expect(() => applyPatch({ a: 1 }, [{ op: "replace", path: "/b/c", value: 1 }])).toThrow();
    expect(() => applyPatch({}, [{ op: "add", path: "/__proto__/x", value: 1 }])).toThrow();
  });
});
