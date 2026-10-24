import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { Cpu, KeyRound, LayoutPanelLeft, MessageSquare, Monitor, Moon, Puzzle, Settings, ShieldCheck, ShieldOff, Sun, TerminalSquare } from "lucide-react";
import { Toaster } from "sonner";
import { api, type HarnessConfig, type PanelInfo, type PluginSummary, type Status } from "../lib/api.ts";
import { useConnection } from "../lib/events.ts";
import { type ThemePref, useTheme } from "../lib/theme.ts";
import { cn } from "../lib/utils.ts";
import { CommandPalette, CommandRunnerDialog } from "./Commands.tsx";
import { PromptHost } from "./Prompts.tsx";
import { Badge, Code, Dot, Kbd, Tooltip, TooltipProvider } from "./ui.tsx";

export const useStatus = () => useQuery({ queryKey: ["status"], queryFn: () => api<Status>("/api/status"), refetchInterval: 15_000, retry: false });
export const usePlugins = () => useQuery({ queryKey: ["plugins"], queryFn: () => api<{ plugins: PluginSummary[]; safeMode: boolean }>("/api/plugins") });
export const usePanels = () => useQuery({ queryKey: ["panels"], queryFn: () => api<{ origin: string | null; panels: PanelInfo[] }>("/api/panels") });
export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: () => api<{ config: HarnessConfig }>("/api/config").then((r) => r.config) });

const PROBLEM_STATES = new Set(["failed", "quarantined", "incompatible"]);

function NavItem({ to, icon, label, badge }: { to: "/" | "/plugins" | "/settings"; icon: React.ReactNode; label: string; badge?: React.ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/", includeSearch: false }}
      className="flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] text-fg/85 hover:bg-black/[0.04] dark:hover:bg-white/[0.05] [&_svg]:size-4 [&_svg]:text-muted"
      activeProps={{ className: "!bg-black/[0.06] dark:!bg-white/[0.08] font-medium !text-fg [&_svg]:!text-accent" }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge}
    </Link>
  );
}

function ThemeSwitch() {
  const { pref, setPref } = useTheme();
  const opts: Array<[ThemePref, React.ReactNode, string]> = [
    ["light", <Sun key="l" />, "浅色"],
    ["system", <Monitor key="s" />, "跟随系统"],
    ["dark", <Moon key="d" />, "深色"],
  ];
  return (
    <div className="flex rounded-[8px] border border-border bg-bg p-0.5">
      {opts.map(([v, icon, label]) => (
        <Tooltip key={v} content={label}>
          <button
            type="button"
            aria-label={label}
            onClick={() => setPref(v)}
            className={cn("flex h-6 flex-1 items-center justify-center rounded-[6px] text-muted [&_svg]:size-3.5", pref === v && "bg-card text-fg shadow-sm")}
          >
            {icon}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function SignIn() {
  return (
    <div className="flex h-full items-center justify-center bg-bg-subtle p-6">
      <div className="w-[440px] rounded-[16px] border border-border bg-card p-7 shadow-card">
        <div className="mb-3 flex size-10 items-center justify-center rounded-[10px] bg-accent-soft text-accent">
          <KeyRound className="size-5" />
        </div>
        <h1 className="text-[17px] font-semibold">需要从终端登录</h1>
        <p className="mt-1.5 text-[13px] text-muted">
          Harness 只在本机运行。为了防止其他网页冒充你访问它，浏览器需要一次性的登录链接。在终端运行下面的命令，它会自动打开已登录的页面：
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-[10px] border border-border bg-bg-subtle px-3 py-2.5 font-mono text-[13px]">
          <TerminalSquare className="size-4 text-muted" /> harness open
        </div>
        <p className="mt-3 text-[12px] text-muted">登录状态保存在仅限本机的 HttpOnly Cookie 中，30 天有效。</p>
      </div>
    </div>
  );
}

function StatusBar() {
  const conn = useConnection();
  const status = useStatus();
  const plugins = usePlugins();
  const list = plugins.data?.plugins ?? [];
  const problems = list.filter((p) => PROBLEM_STATES.has(p.state));
  const sandbox = status.data?.subsystems.plugins?.sandbox;
  const connTone = conn.status === "open" ? "success" : conn.status === "connecting" ? "accent" : "warning";
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-bg-sidebar px-3 text-[11.5px] text-muted" data-testid="status-bar">
      <span className="flex items-center gap-1.5">
        <Dot tone={connTone} />
        {conn.status === "open" ? "已连接" : conn.status === "connecting" ? "正在连接…" : `连接断开，${Math.round((conn.retryInMs ?? 0) / 1000)} 秒后重试`}
      </span>
      {status.data && (
        <Tooltip content="当前使用的模型（在设置中更换）">
          <span className="flex items-center gap-1">
            <Cpu className="size-3.5" />
            {status.data.model.provider}/{status.data.model.id}
          </span>
        </Tooltip>
      )}
      <Link to="/plugins" className="flex items-center gap-1.5 hover:text-fg">
        <Puzzle className="size-3.5" />
        {list.filter((p) => p.state === "active").length} 个运行中 · {list.filter((p) => p.enabled).length} 个已启用
        {problems.length > 0 && <Badge tone="danger">{problems.length} 个有问题</Badge>}
      </Link>
      {plugins.data?.safeMode && <Badge tone="warning">安全模式：所有插件已暂停</Badge>}
      {sandbox && (
        <Tooltip content={sandbox.reason ?? "插件进程运行在 macOS Seatbelt 沙箱中"}>
          <span className={cn("flex items-center gap-1", sandbox.mode !== "seatbelt" && "text-warning")}>
            {sandbox.mode === "seatbelt" ? <ShieldCheck className="size-3.5" /> : <ShieldOff className="size-3.5" />}
            {sandbox.mode === "seatbelt" ? "Seatbelt 沙箱" : sandbox.mode === "degraded" ? "沙箱降级" : "沙箱已关闭"}
          </span>
        </Tooltip>
      )}
      <span className="ml-auto flex items-center gap-1">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd> 命令面板
      </span>
      {status.data && <span>v{status.data.version}</span>}
    </footer>
  );
}

export function Layout() {
  const conn = useConnection();
  const status = useStatus();
  const plugins = usePlugins();
  const config = useConfig();
  const panels = usePanels();
  const theme = useTheme((s) => s.theme);
  const problems = (plugins.data?.plugins ?? []).filter((p) => PROBLEM_STATES.has(p.state)).length;
  const unauthorized = conn.status === "unauthorized" || (status.error as { status?: number } | null)?.status === 401;

  if (unauthorized) return <SignIn />;

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[212px] shrink-0 flex-col border-r border-border bg-bg-sidebar px-2.5 pb-3 pt-4">
            <div className="mb-4 flex items-center gap-2 px-2">
              <div className="flex size-6 items-center justify-center rounded-[7px] bg-accent text-[13px] font-bold text-white">H</div>
              <span className="text-[14px] font-semibold">Harness</span>
              <span className="ml-auto text-[11px] text-muted">本机</span>
            </div>
            <nav className="space-y-0.5">
              <NavItem to="/" icon={<MessageSquare />} label="会话" />
              <NavItem to="/plugins" icon={<Puzzle />} label="插件" badge={problems > 0 ? <Badge tone="danger">{problems}</Badge> : undefined} />
              <NavItem to="/settings" icon={<Settings />} label="设置" />
            </nav>
            {(panels.data?.panels.length ?? 0) > 0 && (
              <div className="mt-5" data-testid="nav-panels">
                <div className="mb-1 px-2.5 text-[11px] font-medium text-muted">插件面板</div>
                <nav className="space-y-0.5">
                  {panels.data?.panels.map((p) => (
                    <Tooltip key={`${p.pluginId}/${p.panelId}`} content={`由 ${p.pluginName} 提供`} side="right">
                      <Link
                        to="/panels/$pluginId/$panelId"
                        params={{ pluginId: p.pluginId, panelId: p.panelId }}
                        className="flex h-8 items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] text-fg/85 hover:bg-black/[0.04] dark:hover:bg-white/[0.05] [&_svg]:size-4 [&_svg]:text-muted"
                        activeProps={{ className: "!bg-black/[0.06] dark:!bg-white/[0.08] font-medium !text-fg [&_svg]:!text-accent" }}
                      >
                        <LayoutPanelLeft />
                        <span className="truncate">{p.title}</span>
                      </Link>
                    </Tooltip>
                  ))}
                </nav>
              </div>
            )}
            <div className="mt-auto space-y-2">
              {config.data?.workspace && (
                <Tooltip content={config.data.workspace} side="right">
                  <div className="truncate px-2 text-[11.5px] text-muted">
                    工作区 <Code className="text-[11px]">{config.data.workspace.split("/").pop()}</Code>
                  </div>
                </Tooltip>
              )}
              <ThemeSwitch />
            </div>
          </aside>
          <main className="min-w-0 flex-1 bg-bg">
            <Outlet />
          </main>
        </div>
        <StatusBar />
      </div>
      <PromptHost />
      <CommandRunnerDialog />
      <CommandPalette workspace={config.data?.workspace ?? null} />
      <Toaster position="bottom-right" richColors closeButton theme={theme} offset={40} />
    </TooltipProvider>
  );
}
