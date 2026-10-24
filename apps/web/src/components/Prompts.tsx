import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { api, errorText } from "../lib/api.ts";
import { useHostEvents } from "../lib/events.ts";
import { TOOL_RISK_LABEL } from "../lib/utils.ts";
import { Badge, Button, Code, Dialog, Json } from "./ui.tsx";

type Item =
  | { kind: "approval"; key: string; approvalId: string; toolName: string; pluginId: string | null; input: unknown; risk: string }
  | { kind: "permission"; key: string; requestId: string; pluginId: string; pluginName?: string; permission: string; label?: string; risk?: string; scope?: string; reason?: string }
  | { kind: "confirm"; key: string; requestId: string; pluginId: string; pluginName?: string; message: string }
  | {
      kind: "local";
      key: string;
      title: string;
      body: React.ReactNode;
      confirmLabel: string;
      danger?: boolean;
      resolve(ok: boolean): void;
    };

interface PromptState {
  queue: Item[];
  push(i: Item): void;
  remove(key: string): void;
}

export const usePrompts = create<PromptState>((set) => ({
  queue: [],
  push: (i) => set((s) => (s.queue.some((q) => q.key === i.key) ? s : { queue: [...s.queue, i] })),
  remove: (key) => set((s) => ({ queue: s.queue.filter((q) => q.key !== key) })),
}));

let localSeq = 0;
/** Ask the user from UI code (e.g. a panel wants to run a write tool). */
export function confirmDialog(opts: { title: string; body: React.ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    usePrompts.getState().push({ kind: "local", key: `local:${++localSeq}`, confirmLabel: opts.confirmLabel ?? "继续", ...opts, resolve });
  });
}

/** Mount once. Turns host events into queued dialogs and toasts. */
export function PromptHost() {
  const { queue, push, remove } = usePrompts();
  const [busy, setBusy] = useState(false);

  useHostEvents((e) => {
    switch (e.type) {
      case "approval.request":
        push({ kind: "approval", key: `ap:${e.approvalId}`, approvalId: e.approvalId, toolName: e.toolName, pluginId: e.pluginId, input: e.input, risk: e.risk });
        break;
      case "approval.resolved":
        remove(`ap:${e.approvalId}`);
        break;
      case "permission.request":
        push({ kind: "permission", key: `pr:${e.requestId}`, ...e });
        break;
      case "confirm.request":
        push({ kind: "confirm", key: `pr:${e.requestId}`, ...e });
        break;
      case "permission.resolved":
        remove(`pr:${e.requestId}`);
        break;
      case "ui.notify": {
        const fn = e.level === "error" ? toast.error : e.level === "warn" ? toast.warning : toast;
        fn(e.message, { description: e.pluginId });
        break;
      }
      case "plugin.error":
        toast.error(`插件 ${e.pluginId} 出错：${e.error.message}`, { description: e.suggestion ?? e.action, duration: 8000 });
        break;
    }
  });

  const current = queue[0];
  if (!current) return null;

  const done = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
      remove(current.key);
    }
  };

  if (current.kind === "local") {
    const finish = (ok: boolean) => {
      current.resolve(ok);
      remove(current.key);
    };
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && finish(false)}
        title={current.title}
        footer={
          <>
            <Button onClick={() => finish(false)}>取消</Button>
            <Button variant={current.danger ? "danger" : "primary"} onClick={() => finish(true)} autoFocus>
              {current.confirmLabel}
            </Button>
          </>
        }
      >
        <div className="text-[13px]">{current.body}</div>
      </Dialog>
    );
  }

  if (current.kind === "approval") {
    const answer = (approved: boolean) => done(() => api(`/api/approvals/${current.approvalId}`, { body: { approved } }));
    return (
      <Dialog
        open
        dismissable={false}
        onOpenChange={() => {}}
        title="需要你的批准"
        description={`Agent 想运行一个${TOOL_RISK_LABEL[current.risk] ?? current.risk}类工具`}
        footer={
          <>
            {queue.length > 1 && <span className="mr-auto text-[12px] text-muted">还有 {queue.length - 1} 个请求</span>}
            <Button disabled={busy} onClick={() => answer(false)} data-testid="approval-deny">
              拒绝
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => answer(true)} autoFocus data-testid="approval-allow">
              允许这一次
            </Button>
          </>
        }
      >
        <div className="space-y-2" data-testid="approval-dialog">
          <div className="flex items-center gap-2">
            <Code>{current.toolName}</Code>
            <Badge tone={current.risk === "read" ? "muted" : "warning"}>{TOOL_RISK_LABEL[current.risk] ?? current.risk}</Badge>
            {current.pluginId && <span className="text-[12px] text-muted">来自插件 {current.pluginId}</span>}
          </div>
          <Json value={current.input} />
        </div>
      </Dialog>
    );
  }

  const decide = (decision: "once" | "always" | "deny") => done(() => api(`/api/prompts/${current.requestId}`, { body: { decision } }));
  const who = current.pluginName ?? current.pluginId;

  if (current.kind === "confirm")
    return (
      <Dialog
        open
        dismissable={false}
        onOpenChange={() => {}}
        title={`${who} 请求确认`}
        footer={
          <>
            <Button disabled={busy} onClick={() => decide("deny")}>
              取消
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => decide("once")} autoFocus>
              确认
            </Button>
          </>
        }
      >
        <div className="whitespace-pre-wrap text-[13px]">{current.message}</div>
      </Dialog>
    );

  return (
    <Dialog
      open
      dismissable={false}
      onOpenChange={() => {}}
      title={`${who} 请求新的权限`}
      description="插件在运行中需要这项权限。你可以只允许这一次，或者一直允许（之后可在插件详情页撤销）。"
      footer={
        <>
          <Button disabled={busy} onClick={() => decide("deny")} data-testid="perm-deny">
            拒绝
          </Button>
          <Button disabled={busy} onClick={() => decide("once")} data-testid="perm-once">
            仅这一次
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => decide("always")} data-testid="perm-always">
            一直允许
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3" data-testid="permission-dialog">
        <ShieldAlert className={current.risk === "high" ? "mt-0.5 size-5 text-danger" : "mt-0.5 size-5 text-warning"} />
        <div className="min-w-0 space-y-1 text-[13px]">
          <div className="font-medium">
            {current.label ?? current.permission} <span className="font-mono text-[11.5px] text-muted">{current.permission}</span>
          </div>
          {current.scope && <div className="break-all font-mono text-[12px]">{current.scope}</div>}
          {current.reason && <div className="text-muted">插件说明：{current.reason}</div>}
        </div>
      </div>
    </Dialog>
  );
}
