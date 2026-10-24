import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { FileDown, MessageSquare, Moon, Play, Puzzle, Settings, Sun, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { create } from "zustand";
import { type ActionView, ApiError, api, type CommandInfo, type CommandRunResult, errorText } from "../lib/api.ts";
import { useTheme } from "../lib/theme.ts";
import { Badge, Button, Code, Dialog, Input, Kbd } from "./ui.tsx";

/** One query for plugin commands; every caller shares the same cache entry and shape. */
export const useCommands = (enabled = true) => useQuery({ queryKey: ["commands"], queryFn: () => api<{ commands: CommandInfo[] }>("/api/commands"), enabled });

// ---- command runner (shared by ⌘K, the chat "/" commands and the plugin page) -------

interface RunnerState {
  cmd: CommandInfo | null;
  args: string;
  sessionId?: string;
  workspace?: string | null;
  autorun: boolean;
  open(cmd: CommandInfo, opts?: { args?: string; sessionId?: string; workspace?: string | null; autorun?: boolean }): void;
  close(): void;
}
export const useCommandRunner = create<RunnerState>((set) => ({
  cmd: null,
  args: "",
  autorun: false,
  open: (cmd, o = {}) => set({ cmd, args: o.args ?? "", sessionId: o.sessionId, workspace: o.workspace, autorun: o.autorun ?? false }),
  close: () => set({ cmd: null }),
}));

const splitArgs = (s: string): string[] => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^["']|["']$/g, ""));

export function CommandRunnerDialog() {
  const { cmd, args: initialArgs, sessionId, workspace, autorun, close } = useCommandRunner();
  const [args, setArgs] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CommandRunResult | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [applied, setApplied] = useState<Record<string, string>>({});

  const run = async (a: string) => {
    if (!cmd) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setApplied({});
    try {
      setResult(await api<CommandRunResult>(`/api/commands/${encodeURIComponent(cmd.name)}`, { body: { args: splitArgs(a), workspace, sessionId } }));
    } catch (e) {
      setError(e as Error);
    } finally {
      setRunning(false);
    }
  };

  // reset per opened command
  useEffect(() => {
    setArgs(initialArgs);
    setResult(null);
    setError(null);
    setApplied({});
    if (cmd && autorun) void run(initialArgs);
  }, [cmd]);

  const apply = async (a: ActionView) => {
    try {
      const r = await api<{ applied: { path: string } }>(`/api/actions/${a.id}/apply`, { method: "POST", body: {} });
      setApplied((s) => ({ ...s, [a.id]: r.applied.path }));
      toast.success(`已写入 ${r.applied.path}`);
    } catch (e) {
      toast.error(errorText(e), { description: e instanceof ApiError ? e.hint : undefined });
    }
  };

  if (!cmd) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={
        <span className="flex items-center gap-2">
          <TerminalSquare className="size-4 text-muted" /> /{cmd.name}
        </span>
      }
      description={`${cmd.description} · 来自 ${cmd.pluginName ?? cmd.pluginId}`}
      className="w-[min(680px,calc(100vw-32px))]"
      footer={
        <>
          <Button onClick={close}>关闭</Button>
          <Button variant="primary" disabled={running} onClick={() => void run(args)} data-testid="command-run">
            <Play /> {result || error ? "再运行一次" : "运行"}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="command-dialog">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(args);
          }}
        >
          <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder={cmd.args ? `参数：${cmd.args}` : "这个命令不需要参数"} className="font-mono" />
        </form>
        {workspace && (
          <div className="text-[12px] text-muted">
            工作区 <Code>{workspace}</Code>
          </div>
        )}
        {running && <div className="text-[12.5px] text-muted">正在运行…（如果插件需要额外权限，会弹出授权请求）</div>}
        {error && (
          <div className="rounded-[10px] border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            <div className="font-medium">{error.message}</div>
            {error instanceof ApiError && error.hint && <div className="mt-0.5 text-fg/80">{error.hint}</div>}
          </div>
        )}
        {result && (
          <div className="space-y-3">
            {(result.markdown || result.text) && (
              <div className="prose-chat max-h-[40vh] overflow-auto rounded-[10px] border border-border bg-bg-subtle px-4 py-3 text-[13px]" data-testid="command-output">
                {result.markdown ? <Markdown remarkPlugins={[remarkGfm]}>{result.markdown}</Markdown> : <pre className="whitespace-pre-wrap">{result.text}</pre>}
              </div>
            )}
            {result.actions?.map((a) => (
              <div key={a.id} className="flex items-center gap-3 rounded-[10px] border border-border px-3 py-2" data-testid="command-action">
                <FileDown className="size-4 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{a.label}</div>
                  <div className="text-[12px] text-muted">
                    {a.mode === "prepend" ? "插入到开头" : a.mode === "append" ? "追加到末尾" : a.mode === "overwrite" ? "覆盖" : "新建"} <Code>{a.path}</Code>
                    {!a.exists && " （文件不存在，将新建）"} · {a.bytes} 字节 · 由宿主写入，插件本身没有写权限
                  </div>
                </div>
                {applied[a.id] ? (
                  <Badge tone="success">已写入</Badge>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => void apply(a)}>
                    确认写入
                  </Button>
                )}
              </div>
            ))}
            {result.actionProblems?.map((p) => (
              <div key={p} className="text-[12px] text-warning">
                {p}
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---- ⌘K palette -------------------------------------------------------------------

export function CommandPalette({ workspace }: { workspace: string | null }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const runner = useCommandRunner();
  const { pref, setPref } = useTheme();
  const qc = useQueryClient();
  const commands = useCommands(open);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        void navigate({ to: "/settings" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const go = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  const item = "flex cursor-default items-center gap-2 rounded-[8px] px-2.5 py-2 text-[13px] aria-selected:bg-accent-soft aria-selected:text-fg [&_svg]:size-4 [&_svg]:text-muted";

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="命令面板"
      overlayClassName="fixed inset-0 z-50 bg-black/25"
      contentClassName="fixed left-1/2 top-[14vh] z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-[14px] border border-border bg-card shadow-2xl"
    >
      <Command.Input placeholder="搜索命令、页面…" className="h-12 w-full border-b border-border bg-transparent px-4 text-[14px] outline-none placeholder:text-muted" />
      <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">没有匹配的命令</Command.Empty>
        <Command.Group heading="前往" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:text-muted">
          <Command.Item className={item} onSelect={() => go(() => void navigate({ to: "/" }))}>
            <MessageSquare /> 会话
          </Command.Item>
          <Command.Item className={item} onSelect={() => go(() => void navigate({ to: "/plugins" }))}>
            <Puzzle /> 插件中心
          </Command.Item>
          <Command.Item className={item} onSelect={() => go(() => void navigate({ to: "/settings" }))}>
            <Settings /> 设置 <span className="ml-auto">
              <Kbd>⌘</Kbd> <Kbd>,</Kbd>
            </span>
          </Command.Item>
        </Command.Group>
        {(commands.data?.commands.length ?? 0) > 0 && (
          <Command.Group heading="插件命令" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:text-muted">
            {commands.data?.commands.map((c) => (
              <Command.Item key={`${c.pluginId}:${c.name}`} value={`/${c.name} ${c.description} ${c.pluginName ?? ""}`} className={item} onSelect={() => go(() => runner.open(c, { workspace }))}>
                <TerminalSquare />
                <span className="font-mono">/{c.name}</span>
                <span className="truncate text-muted">{c.description}</span>
                <span className="ml-auto shrink-0 text-[11.5px] text-muted">{c.pluginName ?? c.pluginId}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        <Command.Group heading="外观" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:text-muted">
          <Command.Item className={item} onSelect={() => go(() => setPref(pref === "dark" ? "light" : "dark"))}>
            {pref === "dark" ? <Sun /> : <Moon />} 切换深色 / 浅色
          </Command.Item>
          <Command.Item className={item} onSelect={() => go(() => void qc.invalidateQueries())}>
            <Puzzle /> 刷新所有数据
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
