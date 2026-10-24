import type { HostEvent } from "@harness/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { AlertCircle, Ban, Check, ChevronRight, CircleDashed, Hand, Info, Loader2, MessageSquarePlus, PanelRight, Send, Square, TerminalSquare, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { useCommandRunner, useCommands } from "../components/Commands.tsx";
import { useConfig, usePanels } from "../components/Layout.tsx";
import { PanelFrame } from "../components/PanelFrame.tsx";
import { Badge, Button, Code, Empty, Json, Tabs, TabsList, TabsTrigger, Textarea, Tooltip } from "../components/ui.tsx";
import { api, type CommandInfo, errorText, type PanelInfo, type Session, type StoredMessage } from "../lib/api.ts";
import { useHostEvents } from "../lib/events.ts";
import { cn, relTime, TOOL_RISK_LABEL } from "../lib/utils.ts";

// ---- view model ---------------------------------------------------------------------

type ToolStatus = "running" | "awaiting" | "ok" | "error" | "blocked";
type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; toolName: string; pluginId: string | null; risk?: string; input: unknown; status: ToolStatus; output?: unknown; error?: { message: string; data?: unknown }; durationMs?: number; blockedBy?: string }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; message: string; pluginId?: string | null }
  | { kind: "error"; id: string; message: string; hint?: string };

interface LiveTurn {
  turnId: string | null;
  items: Item[];
  ended: boolean;
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
function fromHistory(messages: StoredMessage[]): Item[] {
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
        const isErr = r.output?.type?.startsWith("error");
        t.status = isErr ? "error" : "ok";
        t.output = r.output?.value;
        const v = r.output?.value as { blockedBy?: string } | undefined;
        if (v && typeof v === "object" && v.blockedBy) {
          t.status = "blocked";
          t.blockedBy = v.blockedBy;
        }
      }
    }
  }
  return items;
}

function applyEvent(turns: LiveTurn[], e: HostEvent): LiveTurn[] {
  if (!("turnId" in e) && e.type !== "approval.resolved") return turns;
  const next = turns.map((t) => ({ ...t, items: [...t.items] }));
  let turn: LiveTurn | undefined;
  if (e.type === "turn.start") {
    turn = [...next].reverse().find((t) => t.turnId === null && !t.ended);
    if (turn) turn.turnId = e.turnId;
    else next.push({ turnId: e.turnId, items: [], ended: false });
    return next;
  }
  if (e.type === "approval.resolved") {
    for (const t of next)
      t.items = t.items.map((it) => (it.kind === "tool" && it.status === "awaiting" && (it as { approvalId?: string }).approvalId === e.approvalId ? { ...it, status: e.approved ? "running" : "blocked", blockedBy: e.approved ? undefined : "你" } : it));
    return next;
  }
  turn = next.find((t) => t.turnId === (e as { turnId: string }).turnId);
  if (!turn) {
    turn = { turnId: (e as { turnId: string }).turnId, items: [], ended: false };
    next.push(turn);
  }
  const items = turn.items;
  switch (e.type) {
    case "text.delta": {
      const last = items[items.length - 1];
      if (last?.kind === "assistant") items[items.length - 1] = { ...last, text: last.text + e.text };
      else items.push({ kind: "assistant", id: `${e.turnId}:t${items.length}`, text: e.text });
      break;
    }
    case "tool.call":
      items.push({ kind: "tool", id: e.callId, toolName: e.toolName, pluginId: e.pluginId, risk: e.risk, input: e.input, status: "running" });
      break;
    case "approval.request": {
      const idx = items.findLastIndex((it) => it.kind === "tool" && it.toolName === e.toolName && it.status === "running");
      if (idx >= 0) items[idx] = { ...(items[idx] as Extract<Item, { kind: "tool" }>), status: "awaiting", approvalId: e.approvalId } as Item;
      break;
    }
    case "tool.result": {
      const idx = items.findIndex((it) => it.kind === "tool" && it.id === e.callId);
      const patch = { status: (e.blockedBy ? "blocked" : e.ok ? "ok" : "error") as ToolStatus, output: e.output, error: e.error, durationMs: e.durationMs, blockedBy: e.blockedBy };
      if (idx >= 0) items[idx] = { ...(items[idx] as Extract<Item, { kind: "tool" }>), ...patch };
      else items.push({ kind: "tool", id: e.callId, toolName: e.toolName, pluginId: e.pluginId, input: undefined, ...patch });
      break;
    }
    case "notice":
      items.push({ kind: "notice", id: `${e.turnId}:n${items.length}`, level: e.level, message: e.message, pluginId: e.pluginId });
      break;
    case "turn.error": {
      const data = e.error.data as { hint?: string } | undefined;
      items.push({ kind: "error", id: `${e.turnId}:e`, message: e.error.message, hint: data?.hint });
      turn.ended = true;
      break;
    }
    case "turn.end":
      turn.ended = true;
      break;
  }
  return next;
}

// ---- pieces -------------------------------------------------------------------------

const STATUS_ICON: Record<ToolStatus, React.ReactNode> = {
  running: <Loader2 className="size-3.5 animate-spin text-accent" />,
  awaiting: <Hand className="size-3.5 text-warning" />,
  ok: <Check className="size-3.5 text-success" />,
  error: <AlertCircle className="size-3.5 text-danger" />,
  blocked: <Ban className="size-3.5 text-danger" />,
};
const STATUS_TEXT: Record<ToolStatus, string> = { running: "运行中", awaiting: "等待你批准", ok: "完成", error: "失败", blocked: "被拦截" };

function ToolCard({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const errMsg = item.error?.message ?? (item.status === "error" ? (item.output as { message?: string } | undefined)?.message : undefined);
  return (
    <div className={cn("rounded-[10px] border bg-card", item.status === "error" || item.status === "blocked" ? "border-danger/30" : item.status === "awaiting" ? "border-warning/40" : "border-border")} data-testid="tool-card" data-tool={item.toolName} data-status={item.status}>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("size-3.5 text-muted transition-transform", open && "rotate-90")} />
        {STATUS_ICON[item.status]}
        <Wrench className="size-3.5 text-muted" />
        <span className="font-mono text-[12.5px] font-medium">{item.toolName}</span>
        {item.risk && item.risk !== "read" && <Badge tone="warning">{TOOL_RISK_LABEL[item.risk] ?? item.risk}</Badge>}
        {item.pluginId && <span className="truncate text-[11.5px] text-muted">{item.pluginId}</span>}
        <span className="ml-auto shrink-0 text-[11.5px] text-muted">
          {STATUS_TEXT[item.status]}
          {item.durationMs !== undefined && ` · ${item.durationMs} ms`}
        </span>
      </button>
      {(item.blockedBy || errMsg) && !open && (
        <div className="border-t border-border px-3 py-1.5 text-[12px] text-danger">{item.blockedBy ? `被 ${item.blockedBy} 拦截${errMsg ? `：${errMsg}` : ""}` : errMsg}</div>
      )}
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {item.input !== undefined && (
            <div>
              <div className="mb-1 text-[11.5px] text-muted">输入</div>
              <Json value={item.input} />
            </div>
          )}
          {(item.output !== undefined || item.error) && (
            <div>
              <div className="mb-1 text-[11.5px] text-muted">{item.status === "ok" ? "输出" : "错误"}</div>
              <Json value={item.error ?? item.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[78%] whitespace-pre-wrap rounded-[14px] rounded-br-[5px] bg-accent px-3.5 py-2 text-[13.5px] text-accent-fg" data-testid="msg-user">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="prose-chat max-w-[88%] text-[13.5px] leading-[1.6]" data-testid="msg-assistant">
          <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "notice":
      return (
        <div className={cn("flex items-start gap-2 rounded-[8px] px-3 py-1.5 text-[12px]", item.level === "error" ? "bg-danger-soft text-danger" : item.level === "warn" ? "bg-warning-soft text-warning" : "bg-bg-subtle text-muted")} data-testid="notice">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {item.pluginId && <span className="font-medium">{item.pluginId}：</span>}
            {item.message}
          </span>
        </div>
      );
    case "error":
      return (
        <div className="rounded-[10px] border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px]" data-testid="turn-error">
          <div className="flex items-center gap-1.5 font-medium text-danger">
            <AlertCircle className="size-4" /> 这一轮没有完成
          </div>
          <div className="mt-0.5">{item.message}</div>
          {item.hint && <div className="mt-0.5 text-muted">{item.hint}</div>}
        </div>
      );
  }
}

function Composer({ disabled, running, onSend, onCancel, commands, onCommand }: { disabled?: boolean; running: boolean; onSend(text: string): void; onCancel(): void; commands: CommandInfo[]; onCommand(c: CommandInfo, args: string): void }) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const slash = text.startsWith("/") ? text.slice(1).split(/\s/)[0] : null;
  const matches = slash !== null && !text.includes(" ") ? commands.filter((c) => c.name.startsWith(slash)) : [];
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith("/")) {
      const [name, ...rest] = t.slice(1).split(/\s+/);
      const c = commands.find((x) => x.name === name);
      if (c) {
        onCommand(c, rest.join(" "));
        setText("");
        return;
      }
    }
    onSend(t);
    setText("");
  };
  return (
    <div className="relative">
      {matches.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-[12px] border border-border bg-card shadow-card" data-testid="slash-menu">
          {matches.map((c, i) => (
            <button
              type="button"
              key={`${c.pluginId}:${c.name}`}
              className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]", i === sel && "bg-accent-soft")}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                setText(`/${c.name} `);
              }}
            >
              <TerminalSquare className="size-4 text-muted" />
              <span className="font-mono">/{c.name}</span>
              {c.args && <span className="font-mono text-[11.5px] text-muted">{c.args}</span>}
              <span className="truncate text-muted">{c.description}</span>
              <span className="ml-auto shrink-0 text-[11.5px] text-muted">{c.pluginName}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-[14px] border border-border-strong bg-card p-2 shadow-card focus-within:border-accent">
        <Textarea
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          value={text}
          disabled={disabled}
          placeholder="给 Agent 发消息，或输入 / 运行插件命令（Enter 发送，Shift+Enter 换行）"
          className="border-0 bg-transparent px-1.5 py-1 shadow-none focus:ring-0"
          onChange={(e) => {
            setText(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setSel((s) => (s + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (matches.length && e.key === "Tab") {
              e.preventDefault();
              setText(`/${matches[sel].name} `);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (matches.length && text.trim() === `/${slash}` && matches[sel].name !== slash) {
                setText(`/${matches[sel].name} `);
                return;
              }
              submit();
            }
          }}
          data-testid="composer"
        />
        {running ? (
          <Button variant="secondary" size="icon" onClick={onCancel} aria-label="停止">
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button variant="primary" size="icon" disabled={!text.trim() || disabled} onClick={submit} aria-label="发送" data-testid="send">
            <Send />
          </Button>
        )}
      </div>
    </div>
  );
}

// ---- page -----------------------------------------------------------------------------

export function ChatPage() {
  const search = useSearch({ strict: false }) as { s?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const config = useConfig();
  const runner = useCommandRunner();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api<{ sessions: Session[] }>("/api/sessions").then((r) => r.sessions) });
  const currentId = search.s ?? sessions.data?.[0]?.id ?? null;
  const session = useQuery({
    queryKey: ["session", currentId],
    enabled: !!currentId,
    queryFn: () => api<{ session: Session; messages: StoredMessage[]; running: boolean }>(`/api/sessions/${currentId}`),
    refetchOnWindowFocus: false,
  });
  const commands = useCommands();
  const panels = usePanels();
  const sidebarPanels = (panels.data?.panels ?? []).filter((p) => p.location === "sidebar");
  const [showPanels, setShowPanels] = useState(true);
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

  // Reset live turns when switching sessions; drop finished ones once history includes them.
  // keyed on session id
  useEffect(() => setLive([]), [currentId]);
  // on refetch only
  useEffect(() => setLive((l) => l.filter((t) => !t.ended)), [session.dataUpdatedAt]);

  useHostEvents((e) => {
    if (!currentId || !("sessionId" in e) || e.sessionId !== currentId) return;
    setLive((l) => applyEvent(l, e));
    if (e.type === "turn.end" || e.type === "turn.error") void qc.invalidateQueries({ queryKey: ["sessions"] });
  });

  const history = useMemo(() => fromHistory(session.data?.messages ?? []), [session.data]);
  const items = [...history, ...live.flatMap((t) => t.items)];
  const running = live.some((t) => !t.ended) || (session.data?.running ?? false);
  const workspace = session.data?.session.workspace ?? config.data?.workspace ?? null;

  // scroll on new content
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [items.length, live]);

  const createSession = useMutation({
    mutationFn: () => api<{ session: Session }>("/api/sessions", { body: { title: "新会话", workspace: config.data?.workspace } }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["sessions"] });
      void navigate({ to: "/", search: { s: r.session.id } });
    },
  });

  const send = async (text: string) => {
    let id = currentId;
    if (!id) {
      const r = await api<{ session: Session }>("/api/sessions", { body: { title: text.slice(0, 40), workspace: config.data?.workspace } });
      id = r.session.id;
      await qc.invalidateQueries({ queryKey: ["sessions"] });
      void navigate({ to: "/", search: { s: id } });
    }
    setLive((l) => [...l, { turnId: null, items: [{ kind: "user", id: `local:${Date.now()}`, text }], ended: false }]);
    try {
      await api(`/api/sessions/${id}/messages`, { body: { text } });
    } catch (e) {
      setLive((l) => l.map((t) => (t.turnId === null && !t.ended ? { ...t, ended: true, items: [...t.items, { kind: "error", id: `err:${Date.now()}`, message: errorText(e) }] } : t)));
    }
  };

  const remove = async (s: Session) => {
    await api(`/api/sessions/${s.id}`, { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: ["sessions"] });
    if (s.id === currentId) void navigate({ to: "/", search: {} });
  };

  const panel = sidebarPanels.find((p) => `${p.pluginId}/${p.panelId}` === activePanel) ?? sidebarPanels[0];

  return (
    <div className="flex h-full min-h-0">
      {/* sessions */}
      <div className="flex w-[232px] shrink-0 flex-col border-r border-border">
        <div className="flex h-12 items-center justify-between px-3">
          <span className="text-[13px] font-semibold">会话</span>
          <Tooltip content="新会话">
            <Button size="icon-sm" variant="ghost" onClick={() => createSession.mutate()} aria-label="新会话" data-testid="new-session">
              <MessageSquarePlus />
            </Button>
          </Tooltip>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {sessions.data?.map((s) => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => void navigate({ to: "/", search: { s: s.id } })}
              onKeyDown={(e) => e.key === "Enter" && void navigate({ to: "/", search: { s: s.id } })}
              className={cn("group flex cursor-default items-center gap-2 rounded-[8px] px-2.5 py-2", s.id === currentId ? "bg-accent-soft" : "hover:bg-bg-subtle")}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{s.title}</div>
                <div className="text-[11px] text-muted">{relTime(s.updated_at)}</div>
              </div>
              <button
                type="button"
                className="hidden rounded p-1 text-muted hover:bg-danger-soft hover:text-danger group-hover:block"
                aria-label="删除会话"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(s);
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          {sessions.data?.length === 0 && <div className="px-2.5 py-2 text-[12px] text-muted">还没有会话</div>}
        </div>
      </div>

      {/* conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">{session.data?.session.title ?? "新会话"}</div>
          </div>
          {workspace && (
            <Tooltip content="工具在这个目录中工作（在设置中更改默认工作区）">
              <span className="max-w-[300px] truncate font-mono text-[11.5px] text-muted">{workspace}</span>
            </Tooltip>
          )}
          {running && (
            <Badge tone="accent">
              <CircleDashed className="size-3 animate-spin" /> 运行中
            </Badge>
          )}
          {sidebarPanels.length > 0 && (
            <Tooltip content={showPanels ? "隐藏插件面板" : "显示插件面板"}>
              <Button size="icon-sm" variant={showPanels ? "secondary" : "ghost"} onClick={() => setShowPanels(!showPanels)} aria-label="插件面板">
                <PanelRight />
              </Button>
            </Tooltip>
          )}
        </div>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[780px] space-y-3.5 px-6 py-6" data-testid="transcript">
            {items.length === 0 && !session.isLoading && (
              <Empty icon={<MessageSquarePlus />} title="开始一个对话">
                Agent 能用的工具全部来自已启用的插件。试试问「这个仓库最近改了什么？」，或输入 <Code>/</Code> 运行插件命令。
              </Empty>
            )}
            {items.map((it) => (
              <ItemView key={it.id} item={it} />
            ))}
            {running && live.at(-1)?.items.at(-1)?.kind !== "assistant" && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Loader2 className="size-3.5 animate-spin" /> 思考中…
              </div>
            )}
          </div>
        </div>
        <div className="mx-auto w-full max-w-[780px] px-6 pb-5">
          <Composer
            running={running}
            commands={commands.data?.commands ?? []}
            onSend={(t) => void send(t).catch((e) => toast.error(errorText(e)))}
            onCancel={() => currentId && void api(`/api/sessions/${currentId}/cancel`, { method: "POST", body: {} })}
            onCommand={(c, args) => runner.open(c, { args, sessionId: currentId ?? undefined, workspace, autorun: true })}
          />
        </div>
      </div>

      {/* plugin panels */}
      {showPanels && sidebarPanels.length > 0 && panel && (
        <div className="flex w-[380px] shrink-0 flex-col border-l border-border bg-bg-subtle/40" data-testid="panel-sidebar">
          {sidebarPanels.length > 1 && (
            <div className="border-b border-border px-2 py-1.5">
              <Tabs value={`${panel.pluginId}/${panel.panelId}`} onValueChange={setActivePanel}>
                <TabsList>
                  {sidebarPanels.map((p) => (
                    <TabsTrigger key={`${p.pluginId}/${p.panelId}`} value={`${p.pluginId}/${p.panelId}`}>
                      {p.title}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          )}
          <PanelFrame key={`${panel.pluginId}/${panel.panelId}`} panel={panel} workspace={workspace} />
        </div>
      )}
    </div>
  );
}
