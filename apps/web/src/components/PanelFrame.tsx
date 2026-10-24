import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RotateCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, type PanelInfo } from "../lib/api.ts";
import { attachPanelBridge, type HostContext } from "../lib/panel-bridge.ts";
import { panelTokens, useTheme } from "../lib/theme.ts";
import { confirmDialog } from "./Prompts.tsx";
import { Button, Code, Tooltip } from "./ui.tsx";

const READY_TIMEOUT_MS = 10_000;
const NAV_GRACE_MS = 2_000;

/**
 * A plugin panel. The iframe is on the panel origin (different port), sandboxed without
 * allow-same-origin, and its CSP forbids network access; the only channel back is the
 * postMessage bridge below, which relays tools/call to the daemon for this plugin only.
 */
export function PanelFrame({ panel, workspace, className }: { panel: PanelInfo; workspace: string | null; className?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useTheme((s) => s.theme);
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [violation, setViolation] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Counts iframe loads since the last (re)mount. A second load means the panel navigated.
  const loads = useRef(0);
  const readyRef = useRef(false);
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctx = useRef<HostContext>(null as unknown as HostContext);
  ctx.current = {
    theme,
    tokens: typeof document !== "undefined" ? panelTokens() : {},
    workspace,
    locale: "zh-CN",
    pluginId: panel.pluginId,
    panelId: panel.panelId,
    capabilities: panel.capabilities,
  };
  const bridge = useRef<ReturnType<typeof attachPanelBridge> | null>(null);

  // re-attach when the frame is reloaded
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    setReady(false);
    setStalled(false);
    setViolation(null);
    loads.current = 0;
    readyRef.current = false;
    const call = (name: string, args: Record<string, unknown>, confirmed: boolean) =>
      api(`/api/plugins/${encodeURIComponent(panel.pluginId)}/panels/${encodeURIComponent(panel.panelId)}/call`, {
        body: { method: "tools/call", params: { name, arguments: args }, workspace, confirmed },
      });
    const b = attachPanelBridge(el, {
      context: () => ctx.current,
      callTool: async (name, args) => {
        try {
          return await call(name, args, false);
        } catch (e) {
          if (e instanceof ApiError && e.data?.needsConfirmation) {
            const ok = await confirmDialog({
              title: `${panel.pluginName} 的面板想运行 ${name}`,
              body: (
                <div className="space-y-2">
                  <p>这个工具会修改内容或执行命令（风险：{String(e.data?.risk ?? "未知")}）。只有你确认后面板才能继续。</p>
                  <pre className="max-h-48 overflow-auto rounded-md bg-bg-subtle p-2 font-mono text-[11.5px]">{JSON.stringify(args, null, 2)}</pre>
                </div>
              ),
              confirmLabel: "允许这一次",
            });
            if (!ok) throw { code: -32001, message: "用户拒绝了这次操作" };
            return await call(name, args, true);
          }
          throw e instanceof ApiError ? { code: e.code, message: e.message, data: e.data } : e;
        }
      },
      openLink: async (url) => {
        const ok = await confirmDialog({
          title: `${panel.pluginName} 想打开一个链接`,
          body: (
            <div className="space-y-1">
              <p>将在新的浏览器标签页中打开：</p>
              <Code className="break-all">{url}</Code>
            </div>
          ),
          confirmLabel: "打开",
        });
        if (ok) window.open(url, "_blank", "noopener,noreferrer");
        return ok;
      },
      notify: (message, level) => {
        const fn = level === "error" ? toast.error : level === "warning" ? toast.warning : level === "success" ? toast.success : toast;
        fn(message, { description: panel.pluginName });
      },
      onReady: () => {
        readyRef.current = true;
        if (navTimer.current) clearTimeout(navTimer.current);
        navTimer.current = null;
        setReady(true);
      },
      onViolation: setViolation,
    });
    bridge.current = b;
    const t = setTimeout(() => setStalled(true), READY_TIMEOUT_MS);
    return () => {
      clearTimeout(t);
      if (navTimer.current) clearTimeout(navTimer.current);
      navTimer.current = null;
      b.dispose();
      bridge.current = null;
    };
  }, [panel.pluginId, panel.panelId, panel.url, nonce]);

  // The main page's CSP (frame-src = panel origin only) makes the browser refuse any navigation of
  // this frame to another origin, so nothing leaves the machine. Here we only explain what happened:
  // a navigation that is not followed by a fresh handshake is treated as an escape attempt.
  const onFrameLoad = () => {
    loads.current += 1;
    if (loads.current < 2) return;
    readyRef.current = false;
    setReady(false);
    if (navTimer.current) clearTimeout(navTimer.current);
    navTimer.current = setTimeout(() => {
      if (!readyRef.current) setViolation("面板试图离开它自己的页面（跳转到其他地址），宿主已阻止，没有数据被发出。可以点右上角重新加载面板。");
    }, NAV_GRACE_MS);
  };

  // push whenever theme or workspace change
  useEffect(() => {
    bridge.current?.pushContext();
  }, [theme, workspace]);

  if (!panel.url) {
    return (
      <div className="p-4 text-[12.5px] text-muted">
        面板服务没有运行，所以无法显示 {panel.title}。运行 <Code>harness doctor</Code> 查看原因。
      </div>
    );
  }

  return (
    <div className={className ?? "flex h-full min-h-0 flex-col"} data-testid={`panel-${panel.pluginId}-${panel.panelId}`}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {panel.title} <span className="font-normal text-muted">· {panel.pluginName}</span>
        </div>
        <Tooltip content="面板运行在隔离的 iframe 中：不能联网，不能读取宿主页面或 Cookie，只能经宿主调用本插件的工具。">
          <span className="inline-flex items-center gap-1 text-[11.5px] text-success">
            <ShieldCheck className="size-3.5" /> 隔离
          </span>
        </Tooltip>
        <Tooltip content="重新加载面板">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ["panels"] });
              setNonce((n) => n + 1);
            }}
            aria-label="重新加载面板"
          >
            <RotateCw />
          </Button>
        </Tooltip>
      </div>
      {(violation || (stalled && !ready)) && (
        <div className="flex items-start gap-2 border-b border-border bg-warning-soft px-3 py-2 text-[12px] text-warning" data-testid={violation ? "panel-violation" : "panel-stalled"}>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{violation ?? "面板 10 秒内没有完成握手，可能出错了。可以重新加载，或在插件详情页查看日志。"}</span>
        </div>
      )}
      <iframe
        key={nonce}
        ref={frame}
        src={panel.url}
        onLoad={onFrameLoad}
        title={`${panel.pluginName} · ${panel.title}`}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        allow=""
        className="min-h-0 w-full flex-1 border-0 bg-bg"
      />
    </div>
  );
}
