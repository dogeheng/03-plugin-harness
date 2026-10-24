import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, History, Lightbulb, PanelRight, Play, RotateCcw, RotateCw, ShieldCheck, TerminalSquare, Trash2, Wrench } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { useCommandRunner } from "../components/Commands.tsx";
import { useConfig, useStatus } from "../components/Layout.tsx";
import { PermissionList, StateBadge } from "../components/PluginBits.tsx";
import { confirmDialog } from "../components/Prompts.tsx";
import { SchemaForm } from "../components/SchemaForm.tsx";
import { Badge, Button, Card, Code, Empty, Input, Json, SectionTitle, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from "../components/ui.tsx";
import { ApiError, type AuditEvent, api, errorText, type Issue, type PermissionView, type PluginDetail } from "../lib/api.ts";
import { permissionLabel } from "../lib/labels.ts";
import { bytes, relTime, RUNTIME_LABEL, TOOL_RISK_LABEL } from "../lib/utils.ts";
import { updatePlugin, useToggle } from "./Plugins.tsx";

const enc = encodeURIComponent;
const fail = (e: unknown) => toast.error(errorText(e), { description: e instanceof ApiError ? e.hint : undefined });

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "danger" | "warning" }) {
  return (
    <div className="rounded-[10px] border border-border bg-card px-3 py-2.5">
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className={tone === "danger" ? "text-[17px] font-semibold text-danger" : tone === "warning" ? "text-[17px] font-semibold text-warning" : "text-[17px] font-semibold"}>{value}</div>
    </div>
  );
}

function Overview({ p }: { p: PluginDetail }) {
  const tools = p.manifest.contributes?.tools ?? [];
  const commands = p.manifest.contributes?.commands ?? [];
  const runner = useCommandRunner();
  const config = useConfig();
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0 space-y-5">
        <section className="space-y-2">
          <SectionTitle>提供的能力</SectionTitle>
          <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-card">
            {tools.map((t) => (
              <div key={t.name} className="flex items-start gap-3 px-3 py-2.5" data-testid="contrib-tool">
                <Wrench className="mt-0.5 size-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] font-medium">{t.name}</span>
                    {t.title && <span className="text-[12.5px]">{t.title}</span>}
                    <Badge tone={t.risk && t.risk !== "read" ? "warning" : "muted"}>{TOOL_RISK_LABEL[t.risk ?? "read"] ?? t.risk}</Badge>
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted">{t.description}</div>
                </div>
              </div>
            ))}
            {commands.map((c) => (
              <div key={c.name} className="flex items-start gap-3 px-3 py-2.5">
                <TerminalSquare className="mt-0.5 size-4 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12.5px] font-medium">/{c.name}</span>
                    {c.args && <span className="font-mono text-[11.5px] text-muted">{c.args}</span>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted">{c.description}</div>
                </div>
                <Button size="sm" disabled={!p.enabled} onClick={() => runner.open({ name: c.name, description: c.description, args: c.args, pluginId: p.id, pluginName: p.name }, { workspace: config.data?.workspace ?? null })}>
                  <Play /> 运行
                </Button>
              </div>
            ))}
            {p.contributes.hooks.map((h) => (
              <div key={h} className="flex items-center gap-3 px-3 py-2.5">
                <ShieldCheck className="size-4 text-muted" />
                <span className="font-mono text-[12.5px]">{h}</span>
                <span className="text-[12px] text-muted">钩子：在 Agent 运行过程中检查或改写请求</span>
              </div>
            ))}
            {p.contributes.panels.map((x) => (
              <div key={x.id} className="flex items-center gap-3 px-3 py-2.5">
                <PanelRight className="size-4 text-muted" />
                <span className="text-[12.5px] font-medium">{x.title}</span>
                <span className="text-[12px] text-muted">面板 · {x.location === "sidebar" ? "会话侧栏" : "独立页面"}</span>
              </div>
            ))}
            {tools.length + commands.length + p.contributes.hooks.length + p.contributes.panels.length === 0 && <div className="px-3 py-3 text-[12.5px] text-muted">没有声明任何扩展点</div>}
          </div>
        </section>
        {p.readme && (
          <section className="space-y-2">
            <SectionTitle>说明</SectionTitle>
            <Card className="prose-chat px-5 py-4 text-[13px]">
              <Markdown remarkPlugins={[remarkGfm]}>{p.readme}</Markdown>
            </Card>
          </section>
        )}
      </div>
      <aside className="space-y-4 text-[12.5px]">
        <section className="space-y-1.5">
          <SectionTitle>隔离方式</SectionTitle>
          <ul className="space-y-1">
            {(p.isolation.length ? p.isolation : [RUNTIME_LABEL[p.runtime] ?? p.runtime]).map((x) => (
              <li key={x} className="flex items-start gap-1.5">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                {x}
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-1">
          <SectionTitle>信息</SectionTitle>
          <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1">
            <dt className="text-muted">ID</dt>
            <dd className="break-all font-mono text-[11.5px]">{p.id}</dd>
            <dt className="text-muted">运行时</dt>
            <dd>{RUNTIME_LABEL[p.runtime] ?? p.runtime}</dd>
            <dt className="text-muted">作者</dt>
            <dd>{p.author ?? "—"}</dd>
            {p.manifest.license && (
              <>
                <dt className="text-muted">许可</dt>
                <dd>{p.manifest.license}</dd>
              </>
            )}
            <dt className="text-muted">位置</dt>
            <dd className="break-all font-mono text-[11px]">{p.dir}</dd>
            <dt className="text-muted">数据</dt>
            <dd>{bytes(p.kvBytes)}</dd>
          </dl>
        </section>
        {p.issues.length > 0 && (
          <section className="space-y-1">
            <SectionTitle>清单提示</SectionTitle>
            {p.issues.map((i: Issue) => (
              <div key={`${i.code}${i.path}`} className="text-warning">
                {i.message}
              </div>
            ))}
          </section>
        )}
      </aside>
    </div>
  );
}

function Permissions({ p }: { p: PluginDetail }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const audit = useQuery({ queryKey: ["audit", p.id], queryFn: () => api<{ events: AuditEvent[] }>(`/api/audit?plugin=${enc(p.id)}&limit=40`).then((r) => r.events) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["plugin", p.id] });
    void qc.invalidateQueries({ queryKey: ["plugins"] });
    void qc.invalidateQueries({ queryKey: ["audit", p.id] });
  };
  const revoke = async (perm: PermissionView) => {
    const ok = await confirmDialog({
      title: `撤销「${perm.label}」？`,
      body: perm.required ? "这是必需权限。撤销后插件会被停用，直到你重新授予。" : "撤销立即生效：正在运行的插件会被重启，之后再需要时会重新询问你。",
      confirmLabel: "撤销",
      danger: true,
    });
    if (!ok) return;
    setBusy(perm.id);
    try {
      const r = await api<{ revoked: number; warning?: string }>(`/api/plugins/${enc(p.id)}/grants/${enc(perm.id)}`, { method: "DELETE" });
      toast.success(`已撤销 ${perm.label}`, { description: r.warning });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const grant = async (perm: PermissionView) => {
    setBusy(perm.id);
    try {
      await api(`/api/plugins/${enc(p.id)}/grants`, { body: { permission: perm.id, scope: perm.scope } });
      toast.success(`已授予 ${perm.label}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const lastUsed = new Map(p.grants.map((g) => [g.permission, g]));
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionTitle>权限</SectionTitle>
        <PermissionList mode="manage" permissions={p.permissions} onRevoke={revoke} onGrant={grant} busy={busy} />
        {p.grants.length > 0 && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-[11.5px] text-muted">
            {[...lastUsed.values()].map((g) => (
              <span key={g.id}>
                {permissionLabel(g.permission)}：{g.source === "install" ? "安装时授予" : g.source === "prompt" ? "运行中授予" : g.source === "update" ? "更新时授予" : "手动授予"} {relTime(g.grantedAt)}，最近使用 {relTime(g.lastUsedAt)}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="space-y-2">
        <SectionTitle>访问记录</SectionTitle>
        {audit.data?.length ? (
          <div className="overflow-hidden rounded-[10px] border border-border">
            <table className="w-full text-[12px]">
              <tbody className="divide-y divide-border">
                {audit.data.map((a) => (
                  <tr key={a.id} className="bg-card align-top" data-decision={a.decision}>
                    <td className="w-[86px] whitespace-nowrap px-3 py-1.5 text-muted">{relTime(a.ts)}</td>
                    <td className="w-[64px] px-1 py-1.5">
                      <Badge tone={a.decision === "deny" ? "danger" : a.decision === "allow" ? "success" : "muted"}>{a.decision === "deny" ? "拒绝" : a.decision === "allow" ? "允许" : "记录"}</Badge>
                    </td>
                    <td className="px-2 py-1.5">
                      <div>
                        {a.permission ? permissionLabel(a.permission) : a.kind} <span className="font-mono text-[11px] text-muted">{a.kind}</span>
                      </div>
                      {a.target && <div className="break-all font-mono text-[11px] text-fg/75">{a.target.replace(/[\u001e\u001f]/g, "·")}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[12.5px] text-muted">还没有记录。插件每一次读文件、联网、运行命令都会记在这里。</div>
        )}
      </section>
    </div>
  );
}

function Settings({ p }: { p: PluginDetail }) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Issue[]>([]);
  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => api(`/api/plugins/${enc(p.id)}/settings`, { method: "PUT", body: { values } }),
    onSuccess: () => {
      setErrors([]);
      toast.success("设置已保存，插件会在下次调用时使用新设置");
      void qc.invalidateQueries({ queryKey: ["plugin", p.id] });
    },
    onError: (e) => {
      const issues = e instanceof ApiError ? (e.data?.issues as Issue[] | undefined) : undefined;
      if (issues) setErrors(issues);
      fail(e);
    },
  });
  const saveSecret = async (key: string, value: string | null) => {
    try {
      await api(`/api/plugins/${enc(p.id)}/secrets/${enc(key)}`, value === null ? { method: "DELETE" } : { method: "PUT", body: { value } });
      toast.success(value === null ? "已清除" : "已保存到钥匙串");
    } catch (e) {
      fail(e);
    } finally {
      void qc.invalidateQueries({ queryKey: ["plugin", p.id] });
    }
  };
  if (!p.manifest.configSchema) return <Empty title="没有可配置的选项" />;
  return <SchemaForm schema={p.manifest.configSchema} values={p.settings} secretsConfigured={p.secretsConfigured} onSave={(v) => save.mutate(v)} onSaveSecret={saveSecret} saving={save.isPending} errors={errors} />;
}

function Health({ p }: { p: PluginDetail }) {
  const logs = useQuery({ queryKey: ["logs", p.id], queryFn: () => api<{ lines: string[] }>(`/api/plugins/${enc(p.id)}/logs?lines=300`).then((r) => r.lines), refetchInterval: 3000 });
  const trace = useQuery({ queryKey: ["trace", p.id], queryFn: () => api<{ entries: Array<{ ts: string; direction: "in" | "out"; message: unknown }> }>(`/api/plugins/${enc(p.id)}/trace`).then((r) => r.entries), refetchInterval: 3000 });
  const s = p.stats ?? { calls: 0, errors: 0, timeouts: 0, totalMs: 0, activations: 0, lastCallAt: null };
  const snap = p.snapshot;
  const hostSandbox = useStatus().data?.subsystems.plugins?.sandbox?.mode;
  const sandboxText =
    p.runtime === "none"
      ? "Seatbelt 沙箱：不需要（纯声明式插件，没有代码进程）"
      : p.pid
        ? p.sandboxed
          ? "Seatbelt 沙箱：已启用"
          : "Seatbelt 沙箱：未使用（沙箱已关闭或不可用，见底部状态栏）"
        : hostSandbox === "seatbelt"
          ? "Seatbelt 沙箱：插件启动时启用"
          : "Seatbelt 沙箱：不可用（见底部状态栏）";
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 lg:grid-cols-7">
        <Stat label="状态" value={<StateBadge state={p.state} detail={p.stateDetail} />} />
        <Stat label="调用次数" value={s.calls} />
        <Stat label="失败" value={s.errors} tone={s.errors ? "warning" : undefined} />
        <Stat label="超时" value={s.timeouts} tone={s.timeouts ? "warning" : undefined} />
        <Stat label="平均耗时" value={s.calls ? `${Math.round(s.totalMs / s.calls)} ms` : "—"} />
        <Stat label="启动次数" value={s.activations} />
        <Stat label="崩溃" value={snap?.crashes ?? 0} tone={snap?.crashes ? "danger" : undefined} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-muted">
        <span>进程 PID：{p.pid ?? "未运行"}</span>
        <span>启动于：{relTime(snap?.startedAt ?? null)}</span>
        <span>最近调用：{relTime(s.lastCallAt)}</span>
        <span>进行中：{snap?.inflight ?? 0}</span>
        {snap?.sdk?.version && (
          <span>
            SDK：{snap.sdk.name} {snap.sdk.version}
          </span>
        )}
        <span data-testid="plugin-sandbox">{sandboxText}</span>
      </div>
      {p.lastError && (
        <Card className="space-y-1 border-danger/30 bg-danger-soft px-4 py-3 text-[12.5px]">
          <div className="font-medium text-danger">最近一次错误{p.lastError.at ? `（${relTime(p.lastError.at)}）` : ""}</div>
          <div>{p.lastError.message}</div>
          {p.lastError.suggestion && (
            <div className="flex items-start gap-1 text-fg/80">
              <Lightbulb className="mt-0.5 size-3.5 shrink-0" />
              {p.lastError.suggestion}
            </div>
          )}
        </Card>
      )}
      <section className="space-y-2">
        <SectionTitle>插件日志（stderr 与 SDK 日志，最近 300 行）</SectionTitle>
        <pre className="max-h-[320px] overflow-auto rounded-[10px] border border-border bg-bg-subtle p-3 font-mono text-[11.5px] leading-[1.5]" data-testid="plugin-logs">
          {logs.data?.length ? logs.data.join("\n") : "（暂无日志）"}
        </pre>
      </section>
      <section className="space-y-2">
        <SectionTitle>协议追踪（宿主与插件之间最近的 JSON-RPC 消息，调试用）</SectionTitle>
        <div className="max-h-[320px] space-y-1 overflow-auto">
          {trace.data?.length ? (
            [...trace.data].reverse().map((t, i) => (
              <details key={`${t.ts}${i}`} className="rounded-[8px] border border-border bg-card px-3 py-1.5 text-[12px]">
                <summary className="cursor-default">
                  <span className={t.direction === "out" ? "text-accent" : "text-success"}>{t.direction === "out" ? "宿主 → 插件" : "插件 → 宿主"}</span>{" "}
                  <span className="font-mono">{(t.message as { method?: string }).method ?? `响应 #${(t.message as { id?: unknown }).id}`}</span> <span className="text-muted">{new Date(t.ts).toLocaleTimeString()}</span>
                </summary>
                <Json value={t.message} className="mt-1.5" />
              </details>
            ))
          ) : (
            <div className="text-[12.5px] text-muted">（暂无消息。插件第一次被使用时才会启动。）</div>
          )}
        </div>
      </section>
    </div>
  );
}

function Versions({ p }: { p: PluginDetail }) {
  const qc = useQueryClient();
  const [source, setSource] = useState("");
  const rollback = async () => {
    try {
      const r = await api<{ from: string; to: string }>(`/api/plugins/${enc(p.id)}/rollback`, { method: "POST", body: {} });
      toast.success(`已从 ${r.from} 回滚到 ${r.to}`);
    } catch (e) {
      fail(e);
    } finally {
      void qc.invalidateQueries({ queryKey: ["plugin", p.id] });
      void qc.invalidateQueries({ queryKey: ["plugins"] });
    }
  };
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionTitle>已安装的版本</SectionTitle>
        <div className="divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-card">
          {p.versions.map((v, i) => (
            <div key={v.version} className="flex items-center gap-3 px-3 py-2.5 text-[12.5px]">
              <History className="size-4 text-muted" />
              <span className="font-medium">v{v.version}</span>
              {v.version === p.version && <Badge tone="success">当前</Badge>}
              <span className="text-muted">安装于 {relTime(v.installedAt)}</span>
              <span className="truncate font-mono text-[11px] text-muted">{v.verified ?? ""}</span>
              {i > 0 && v.version !== p.version && <span className="ml-auto text-[11.5px] text-muted">可回滚</span>}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={p.versions.length < 2 || p.dev} onClick={() => void rollback()}>
            <RotateCcw /> 回滚到上一个版本
          </Button>
          <span className="text-[11.5px] text-muted">旧版本会保留，回滚不需要重新下载。</span>
        </div>
      </section>
      {!p.dev && (
        <section className="space-y-2">
          <SectionTitle>从指定来源更新</SectionTitle>
          <div className="flex items-center gap-2">
            <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder="新版本所在的目录或 .harnessplugin 文件（留空则使用原来源）" className="max-w-[520px] font-mono" />
            <Button size="sm" variant="primary" onClick={() => void updatePlugin(p.id, source.trim() || undefined, qc)}>
              检查并更新
            </Button>
          </div>
          <div className="text-[11.5px] text-muted">新版本如果要求更多权限，会先征得你的同意。</div>
        </section>
      )}
      {p.changelog && (
        <section className="space-y-2">
          <SectionTitle>更新日志</SectionTitle>
          <Card className="prose-chat px-5 py-4 text-[13px]">
            <Markdown remarkPlugins={[remarkGfm]}>{p.changelog}</Markdown>
          </Card>
        </section>
      )}
    </div>
  );
}

export function PluginDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toggle = useToggle();
  const q = useQuery({ queryKey: ["plugin", id], queryFn: () => api<PluginDetail>(`/api/plugins/${enc(id)}`), retry: false });
  const [tab, setTab] = useState("overview");

  if (q.error) {
    return (
      <div className="p-8">
        <Empty title="找不到这个插件">{errorText(q.error)}</Empty>
      </div>
    );
  }
  const p = q.data;
  if (!p) return <div className="p-8 text-muted">加载中…</div>;

  const restart = async () => {
    try {
      await api(`/api/plugins/${enc(p.id)}/restart`, { method: "POST", body: {} });
      toast.success("已重启");
    } catch (e) {
      fail(e);
    } finally {
      void qc.invalidateQueries({ queryKey: ["plugin", p.id] });
    }
  };
  const uninstall = async () => {
    let keepData = false;
    const ok = await confirmDialog({
      title: `卸载 ${p.name}？`,
      body: (
        <div className="space-y-2">
          <p>它提供的工具、命令和面板会立即下线，授予的权限会全部撤销。</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" onChange={(e) => (keepData = e.target.checked)} className="accent-[var(--accent)]" /> 保留插件的数据和设置（重新安装时恢复）
          </label>
        </div>
      ),
      confirmLabel: "卸载",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/plugins/${enc(p.id)}${keepData ? "?keepData=1" : ""}`, { method: "DELETE" });
      toast.success(`已卸载 ${p.name}`);
      await qc.invalidateQueries({ queryKey: ["plugins"] });
      void navigate({ to: "/plugins" });
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1040px] px-8 py-6">
        <Link to="/plugins" className="mb-3 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-fg">
          <ArrowLeft className="size-3.5" /> 插件
        </Link>
        <div className="mb-5 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[20px] font-semibold" data-testid="plugin-title">
                {p.name}
              </h1>
              <span className="text-[13px] text-muted">v{p.version}</span>
              {p.dev && <Badge tone="accent">开发模式</Badge>}
              <StateBadge state={p.state} detail={p.stateDetail} />
            </div>
            <p className="mt-1 text-[13px] text-muted">{p.description}</p>
            {p.dev && (
              <p className="mt-1 text-[12px] text-muted">
                直接使用 <Code>{p.dir}</Code>，保存文件后会自动重启。
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip content="重启插件进程（不影响设置和授权）">
              <Button size="icon" disabled={!p.enabled} onClick={() => void restart()} aria-label="重启">
                <RotateCw />
              </Button>
            </Tooltip>
            <Button variant="danger-ghost" onClick={() => void uninstall()} data-testid="uninstall">
              <Trash2 /> 卸载
            </Button>
            <label className="flex items-center gap-2 rounded-[8px] border border-border px-3 py-1.5 text-[12.5px]">
              {p.enabled ? "已启用" : "已禁用"}
              <Switch checked={p.enabled} disabled={toggle.isPending} onCheckedChange={(on) => toggle.mutate({ id: p.id, on })} data-testid="detail-toggle" />
            </label>
          </div>
        </div>
        {p.lastError && ["failed", "quarantined", "incompatible"].includes(p.state) && (
          <div className="mb-5 flex items-start gap-3 rounded-[10px] border border-danger/30 bg-danger-soft px-4 py-3 text-[12.5px]" data-testid="plugin-error">
            <div className="flex-1">
              <div className="font-medium text-danger">{p.state === "quarantined" ? "插件已被隔离" : p.state === "incompatible" ? "插件与当前版本不兼容" : "插件出错了"}</div>
              <div className="mt-0.5">{p.lastError.message}</div>
              {p.lastError.suggestion && (
                <div className="mt-0.5 flex items-start gap-1 text-fg/80">
                  <Lightbulb className="mt-0.5 size-3.5 shrink-0" />
                  {p.lastError.suggestion}
                </div>
              )}
            </div>
            <Button size="sm" onClick={() => setTab("health")}>
              查看日志
            </Button>
            {p.state === "quarantined" && (
              <Button size="sm" variant="primary" onClick={() => void restart()}>
                解除隔离并重启
              </Button>
            )}
          </div>
        )}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="permissions">权限</TabsTrigger>
            <TabsTrigger value="settings">设置</TabsTrigger>
            <TabsTrigger value="health">健康与日志</TabsTrigger>
            <TabsTrigger value="versions">版本</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-5">
            <Overview p={p} />
          </TabsContent>
          <TabsContent value="permissions" className="mt-5">
            <Permissions p={p} />
          </TabsContent>
          <TabsContent value="settings" className="mt-5">
            <Settings p={p} />
          </TabsContent>
          <TabsContent value="health" className="mt-5">
            <Health p={p} />
          </TabsContent>
          <TabsContent value="versions" className="mt-5">
            <Versions p={p} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
