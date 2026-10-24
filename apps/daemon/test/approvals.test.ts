import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { ApprovalBroker } from "../src/agent/tools.ts";
import { EventBus } from "../src/events/bus.ts";

const args = { sessionId: "s", turnId: "t", toolName: "write", pluginId: null, input: {}, risk: "write" as const };

describe("approval cancellation", () => {
  it("immediately rejects an already cancelled request without opening a prompt", async () => {
    const bus = new EventBus();
    const broker = new ApprovalBroker(bus);
    const events: unknown[] = [];
    bus.on((e) => events.push(e));
    expect(await broker.request(args, AbortSignal.abort())).toBe(false);
    expect(broker.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("removes the abort listener when resolved or cancelled", async () => {
    const broker = new ApprovalBroker(new EventBus());
    const ac = new AbortController();
    const approved = broker.request(args, ac.signal);
    broker.resolve(broker.list()[0], true);
    expect(await approved).toBe(true);
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
    const cancelled = broker.request(args, ac.signal);
    ac.abort();
    expect(await cancelled).toBe(false);
    expect(broker.list()).toEqual([]);
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });
});
