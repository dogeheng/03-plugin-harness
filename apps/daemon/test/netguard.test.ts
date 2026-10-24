import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuardedAgent, guardedLookup, privateAddressCause, PrivateAddressError, type Resolver } from "../src/plugins/netguard.ts";

const fakeDns =
  (table: Record<string, LookupAddress[]>): Resolver =>
  (host, cb) => {
    const r = table[host];
    if (r) cb(null, r);
    else cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }), []);
  };

const lookupOnce = (fn: ReturnType<typeof guardedLookup>, host: string, opts: { all?: boolean; family?: number } = {}) =>
  new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) => fn(host, opts, (err, address, family) => resolve({ err, address, family })));

const dns = fakeDns({
  "public.example": [{ address: "93.184.216.34", family: 4 }],
  "rebind.example": [{ address: "127.0.0.1", family: 4 }],
  "mixed.example": [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ],
  "v6.example": [
    { address: "2606:2800:220:1::1", family: 6 },
    { address: "93.184.216.34", family: 4 },
  ],
  "mapped.example": [{ address: "::ffff:7f00:1", family: 6 }],
});

describe("guardedLookup", () => {
  const fn = guardedLookup(() => false, dns);

  it("passes public answers through, in both callback shapes", async () => {
    expect(await lookupOnce(fn, "public.example")).toMatchObject({ err: null, address: "93.184.216.34", family: 4 });
    const all = await lookupOnce(fn, "v6.example", { all: true });
    expect(all.err).toBeNull();
    expect(all.address).toHaveLength(2);
    expect(await lookupOnce(fn, "v6.example", { family: 4 })).toMatchObject({ address: "93.184.216.34", family: 4 });
  });

  it("refuses a public-looking name that resolves to loopback (DNS rebinding)", async () => {
    const r = await lookupOnce(fn, "rebind.example");
    expect(r.err).toBeInstanceOf(PrivateAddressError);
    expect(r.err?.message).toContain("127.0.0.1");
  });

  it("refuses the whole answer when any record is private, including IPv4-mapped IPv6", async () => {
    expect((await lookupOnce(fn, "mixed.example", { all: true })).err).toBeInstanceOf(PrivateAddressError);
    expect((await lookupOnce(fn, "mapped.example")).err).toBeInstanceOf(PrivateAddressError);
  });

  it("allows private answers only for explicitly listed hosts", async () => {
    const explicit = guardedLookup((h) => h === "rebind.example", dns);
    expect(await lookupOnce(explicit, "rebind.example")).toMatchObject({ err: null, address: "127.0.0.1" });
  });

  it("passes resolver errors through unchanged", async () => {
    const r = await lookupOnce(fn, "missing.example");
    expect((r.err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

describe("createGuardedAgent with a real connection", () => {
  let server: Server;
  let port = 0;
  let hits = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end("local service");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("the check happens at connect time: a rebinding name never reaches the local server", async () => {
    const agent = createGuardedAgent(() => false, dns);
    const before = hits;
    const err = await fetch(`http://rebind.example:${port}/`, { dispatcher: agent }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(privateAddressCause(err)).toBeInstanceOf(PrivateAddressError);
    expect(hits).toBe(before);
    await agent.close();
  });

  it("an explicitly allowed name connects normally", async () => {
    const agent = createGuardedAgent((h) => h === "rebind.example", dns);
    const res = await fetch(`http://rebind.example:${port}/`, { dispatcher: agent });
    expect(await res.text()).toBe("local service");
    await agent.close();
  });
});
