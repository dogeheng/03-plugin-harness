import type { StoredMessage, StoredToolCall } from "./api.ts";

export type ToolStatus = "running" | "awaiting" | "ok" | "error" | "blocked";
export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; toolName: string; pluginId: string | null; risk?: string; input: unknown; status: ToolStatus; output?: unknown; error?: { message: string; data?: unknown }; durationMs?: number; blockedBy?: string }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; message: string; pluginId?: string | null }
  | { kind: "error"; id: string; message: string; hint?: string };

export interface LiveTurn {
  turnId: string | null;
  items: Item[];
  ended: boolean;
  endedAt?: number;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((p): p is { type: "text"; text: string } => p?.type === "text")
      .map((p) => p.text)
      .join("");
  return "";
};

/** Rebuild the transcript from persisted AI SDK ModelMessages. */
export function fromHistory(messages: StoredMessage[], calls: StoredToolCall[] = []): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const m of messages) {
    const c = m.content.content;
    if (m.role === "user") items.push({ kind: "user", id: m.id, text: textOf(c) });
    else if (m.role === "assistant") {
      const parts = Array.isArray(c) ? c : [{ type: "text", text: String(c ?? "") }];
      parts.forEach((p: { type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown }, i: number) => {
        if (p.type === "text" && p.text) items.push({ kind: "assistant", id: `${m.id}:${i}`, text: p.text });
        if (p.type === "tool-call" && p.toolCallId) {
          const t: Extract<Item, { kind: "tool" }> = { kind: "tool", id: p.toolCallId, toolName: p.toolName ?? "?", pluginId: null, input: p.input, status: "ok" };
          tools.set(p.toolCallId, t);
          items.push(t);
        }
      });
    } else if (m.role === "tool" && Array.isArray(c)) {
      for (const r of c as Array<{ toolCallId: string; output?: { type: string; value: unknown } }>) {
        const t = tools.get(r.toolCallId);
        if (!t) continue;
        const value = r.output?.value;
        const v = value && typeof value === "object" ? value as { error?: string; reason?: string; message?: string; blockedBy?: string } : undefined;
        const isErr = r.output?.type?.startsWith("error") || typeof v?.error === "string";
        t.status = isErr ? "error" : "ok";
        t.output = value;
        if (isErr) t.error = { message: typeof value === "string" ? value : v?.reason ?? v?.message ?? v?.error ?? "工具调用失败" };
        if (v?.blockedBy || v?.error === "blocked_by_policy" || v?.error === "denied_by_user") {
          t.status = "blocked";
          t.blockedBy = v.blockedBy ?? (v.error === "denied_by_user" ? "你" : "策略");
        }
      }
    }
  }
  for (const call of calls) {
    const item = tools.get(call.id);
    if (!item) continue;
    item.pluginId = call.plugin_id;
    item.durationMs = call.duration_ms;
    item.status = call.status === "denied" ? "blocked" : call.status;
    if (call.error) item.error = { message: call.error };
    if (call.status === "denied") item.blockedBy = "你";
  }
  return items;
}

/** A response requested before a turn ended can contain incomplete history. */
export function retireSyncedTurns(turns: LiveTurn[], requestedAt: number): LiveTurn[] {
  return turns.filter((turn) => !turn.ended || turn.endedAt === undefined || turn.endedAt >= requestedAt);
}
