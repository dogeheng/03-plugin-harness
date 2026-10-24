import { describe, expect, it } from "vitest";
import { fromHistory, retireSyncedTurns, type LiveTurn } from "../apps/web/src/lib/transcript.ts";
import type { StoredMessage } from "../apps/web/src/lib/api.ts";

function history(output: { type: string; value: unknown }): StoredMessage[] {
  return [
    { id: "m1", seq: 1, role: "assistant", createdAt: "", content: { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "crash", input: {} }] } },
    { id: "m2", seq: 2, role: "tool", createdAt: "", content: { role: "tool", content: [{ type: "tool-result", toolCallId: "call", output }] } },
  ];
}

describe("persisted transcript", () => {
  it("keeps structured tool failures visible after refreshing history", () => {
    expect(fromHistory(history({ type: "json", value: { error: "tool_unavailable", reason: "插件进程意外退出" } }))).toMatchObject([
      { kind: "tool", toolName: "crash", status: "error", error: { message: "插件进程意外退出" } },
    ]);
  });
  it("retains denied approvals and string errors", () => {
    expect(fromHistory(history({ type: "json", value: { error: "denied_by_user", reason: "用户拒绝" } }))[0]).toMatchObject({ status: "blocked", blockedBy: "你" });
    expect(fromHistory(history({ type: "error-text", value: "offline" }))[0]).toMatchObject({ status: "error", error: { message: "offline" } });
  });
  it("restores the plugin identity, duration and recorded status", () => {
    const messages = history({ type: "json", value: { error: "denied_by_user", reason: "用户拒绝" } });
    expect(fromHistory(messages, [{ id: "call", plugin_id: "dev.example.plugin", status: "denied", error: "用户拒绝", duration_ms: 42 }])[0]).toMatchObject({
      pluginId: "dev.example.plugin", status: "blocked", blockedBy: "你", durationMs: 42,
    });
  });
  it("does not discard a finished live turn when an older response arrives", () => {
    const done: LiveTurn = { turnId: "done", ended: true, endedAt: 20, items: [] };
    const running: LiveTurn = { turnId: "running", ended: false, items: [] };
    expect(retireSyncedTurns([done, running], 10)).toEqual([done, running]);
    expect(retireSyncedTurns([done, running], 30)).toEqual([running]);
  });
});
