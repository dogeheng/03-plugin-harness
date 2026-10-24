import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Check, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfig, usePanels, useStatus } from "../components/Layout.tsx";
import { PanelFrame } from "../components/PanelFrame.tsx";
import { Badge, Button, Card, Empty, Input, SectionTitle, Select } from "../components/ui.tsx";
import { ApiError, type AuditEvent, api, errorText, type HarnessConfig, type PanelInfo, type Provider } from "../lib/api.ts";
import { permissionLabel } from "../lib/labels.ts";
import { type ThemePref, useTheme } from "../lib/theme.ts";
import { relTime } from "../lib/utils.ts";

const fail = (e: unknown) => toast.error(errorText(e), { description: e instanceof ApiError ? e.hint : undefined });

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_1fr] items-start gap-6 px-5 py-3.5">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] text-muted">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ModelSection({ config }: { config: HarnessConfig }) {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api<{ providers: Provider[] }>("/api/providers").then((r) => r.providers) });
  const [provider, setProvider] = useState(config.model.provider);
  const [model, setModel] = useState(config.model.id);
  const [key, setKey] = useState("");
  useEffect(() => {
    setProvider(config.model.provider);
    setModel(config.model.id);
  }, [config.model.provider, config.model.id]);
  const p = providers.data?.find((x) => x.id === provider);
  const saveModel = useMutation({
    mutationFn: () => api("/api/config/model", { method: "PUT", body: { provider, id: model } }),
    onSuccess: () => {
      toast.success(`已切换到 ${provider}/${model}`);
      void qc.invalidateQueries({ queryKey: ["config"] });
      void qc.invalidateQueries({ queryKey: ["status"] });
    },
    onError: fail,
  });
  const saveKey = async (remove = false) => {
    try {
      if (remove) await api(`/api/providers/${provider}/key`, { method: "DELETE" });
      else await api(`/api/providers/${provider}/key`, { method: "PUT", body: { apiKey: key } });
      setKey("");
      toast.success(remove ? "已从钥匙串删除" : "已保存到 macOS 钥匙串");
      void qc.invalidateQueries({ queryKey: ["providers"] });
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Card className="divide-y divide-border">
      <Row label="模型提供方">
        <Select value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="provider-select">
          {providers.data?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </Select>
        {p?.baseURL && <div className="mt-1 font-mono text-[11.5px] text-muted">{p.baseURL}</div>}
      </Row>
      <Row label="模型" hint="提供方的模型 ID">
        <div className="flex items-center gap-2">
          <Input list="model-suggestions" value={model} onChange={(e) => setModel(e.target.value)} className="max-w-[360px] font-mono" />
          <datalist id="model-suggestions">
            {p?.exampleModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <Button variant="primary" size="sm" disabled={saveModel.isPending || (provider === config.model.provider && model === config.model.id)} onClick={() => saveModel.mutate()}>
            使用这个模型
          </Button>
        </div>
      </Row>
      {p?.requiresKey && (
        <Row label="API Key" hint="只保存在 macOS 钥匙串，不写入任何文件，插件无法读取">
          <div className="flex items-center gap-2">
            <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.configured ? "已设置（输入新值以替换）" : "粘贴 API Key"} className="max-w-[360px]" />
            <Button size="sm" disabled={key.trim().length < 8} onClick={() => void saveKey()}>
              <KeyRound /> 保存
            </Button>
            {p.configured ? (
              <>
                <Badge tone="success">
                  <Check className="size-3" /> 已设置
                </Badge>
                <Button size="sm" variant="danger-ghost" onClick={() => void saveKey(true)}>
                  删除
                </Button>
              </>
            ) : (
              <Badge tone="warning">未设置</Badge>
            )}
          </div>
        </Row>
      )}
    </Card>
  );
}

const RISKS: Array<[keyof HarnessConfig["approvals"], string, string]> = [
  ["read", "只读工具", "例如读取 git 状态"],
  ["network", "联网工具", "访问外部网站或 API"],
  ["write", "写入工具", "修改文件"],
  ["exec", "执行工具", "运行命令"],
];

function AgentSection({ config }: { config: HarnessConfig }) {
  const qc = useQueryClient();
  const [workspace, setWorkspace] = useState(config.workspace ?? "");
  useEffect(() => setWorkspace(config.workspace ?? ""), [config.workspace]);
  const patch = async (body: Record<string, unknown>, msg: string) => {
    try {
      await api("/api/config", { method: "PATCH", body });
      toast.success(msg);
      void qc.invalidateQueries({ queryKey: ["config"] });
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Card className="divide-y divide-border">
      <Row label="默认工作区" hint="新会话里工具操作的目录，例如一个 Git 仓库">
        <div className="flex items-center gap-2">
          <Input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="/Users/you/code/project" className="max-w-[460px] font-mono" data-testid="workspace-input" />
          <Button size="sm" disabled={workspace === (config.workspace ?? "")} onClick={() => void patch({ workspace }, "已更新默认工作区")}>
            保存
          </Button>
        </div>
      </Row>
      <Row label="工具审批" hint="Agent 调用插件工具前是否需要你点「允许」">
        <div className="space-y-2">
          {RISKS.map(([k, label, hint]) => (
            <div key={k} className="flex items-center gap-3">
              <span className="w-[80px] text-[13px]">{label}</span>
              <Select value={config.approvals[k]} onChange={(e) => void patch({ approvals: { [k]: e.target.value } }, `${label}：${e.target.value === "ask" ? "每次询问" : "自动允许"}`)} data-testid={`approval-${k}`}>
                <option value="ask">每次询问</option>
                <option value="auto">自动允许</option>
              </Select>
              <span className="text-[11.5px] text-muted">{hint}</span>
            </div>
          ))}
        </div>
      </Row>
      <Row label="最多步数" hint="一轮对话里模型最多调用几次工具">
        <Select value={String(config.agent.maxSteps)} onChange={(e) => void patch({ maxSteps: Number(e.target.value) }, "已更新")}>
          {[4, 8, 12, 20, 30].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Row>
    </Card>
  );
}

function Appearance() {
  const { pref, setPref } = useTheme();
  return (
    <Card>
      <Row label="外观" hint="插件面板会跟随同一套主题">
        <Select value={pref} onChange={(e) => setPref(e.target.value as ThemePref)}>
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </Select>
      </Row>
    </Card>
  );
}

function AuditSection() {
  const [onlyDeny, setOnlyDeny] = useState(false);
  const audit = useQuery({ queryKey: ["audit", "all", onlyDeny], queryFn: () => api<{ events: AuditEvent[] }>(`/api/audit?limit=100${onlyDeny ? "&decision=deny" : ""}`).then((r) => r.events) });
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        <span className="text-[12.5px] text-muted">所有插件的文件、网络、命令访问，以及授权变化</span>
        <label className="ml-auto flex items-center gap-1.5 text-[12.5px]">
          <input type="checkbox" checked={onlyDeny} onChange={(e) => setOnlyDeny(e.target.checked)} className="accent-[var(--accent)]" /> 只看被拒绝的
        </label>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-[12px]">
          <tbody className="divide-y divide-border">
            {audit.data?.map((a) => (
              <tr key={a.id} className="align-top">
                <td className="w-[86px] whitespace-nowrap px-5 py-1.5 text-muted">{relTime(a.ts)}</td>
                <td className="w-[150px] truncate px-1 py-1.5 font-mono text-[11px]">{a.plugin_id ?? "宿主"}</td>
                <td className="w-[60px] px-1 py-1.5">
                  <Badge tone={a.decision === "deny" ? "danger" : a.decision === "allow" ? "success" : "muted"}>{a.decision === "deny" ? "拒绝" : a.decision === "allow" ? "允许" : "记录"}</Badge>
                </td>
                <td className="px-2 py-1.5 pr-5">
                  {a.permission ? permissionLabel(a.permission) : a.kind} <span className="font-mono text-[11px] text-muted">{a.kind}</span>
                  {a.target && <div className="break-all font-mono text-[11px] text-fg/75">{a.target.replace(/[\u001e\u001f]/g, "·")}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {audit.data?.length === 0 && <div className="px-5 py-6 text-center text-[12.5px] text-muted">没有记录</div>}
      </div>
    </Card>
  );
}

function About() {
  const s = useStatus().data;
  if (!s) return null;
  const sb = s.subsystems.plugins?.sandbox;
  return (
    <Card className="divide-y divide-border text-[12.5px]">
      <Row label="版本">
        v{s.version} · PID {s.pid} · 已运行 {Math.round(s.uptimeSec / 60)} 分钟
      </Row>
      <Row label="数据目录">
        <span className="font-mono text-[11.5px]">{s.home}</span>
      </Row>
      <Row label="本地接口">
        <span className="font-mono text-[11.5px]">
          http://127.0.0.1:{s.port} · {s.socketPath}
        </span>
      </Row>
      <Row label="密钥存储">{s.secretsBackend === "keychain" ? "macOS 钥匙串" : s.secretsBackend}</Row>
      <Row label="插件沙箱">{sb ? (sb.mode === "seatbelt" ? "macOS Seatbelt（每个插件进程单独的规则）" : `${sb.mode}${sb.reason ? `：${sb.reason}` : ""}`) : "—"}</Row>
      <Row label="插件面板源">
        <span className="font-mono text-[11.5px]">{s.subsystems.panels?.origin ?? "未运行"}</span>
      </Row>
    </Card>
  );
}

export function SettingsPage() {
  const config = useConfig();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[880px] space-y-7 px-8 py-7">
        <h1 className="text-[20px] font-semibold">设置</h1>
        {config.data && (
          <>
            <section className="space-y-2">
              <SectionTitle>模型</SectionTitle>
              <ModelSection config={config.data} />
            </section>
            <section className="space-y-2">
              <SectionTitle>Agent</SectionTitle>
              <AgentSection config={config.data} />
            </section>
          </>
        )}
        <section className="space-y-2">
          <SectionTitle>外观</SectionTitle>
          <Appearance />
        </section>
        <section className="space-y-2">
          <SectionTitle>审计日志</SectionTitle>
          <AuditSection />
        </section>
        <section className="space-y-2">
          <SectionTitle>关于</SectionTitle>
          <About />
        </section>
      </div>
    </div>
  );
}

/** Full-page host for panels with location "main" (also reachable for sidebar panels). */
export function PanelPage() {
  const { pluginId, panelId } = useParams({ strict: false }) as { pluginId: string; panelId: string };
  const config = useConfig();
  const panels = usePanels();
  const panel = panels.data?.panels.find((p) => p.pluginId === pluginId && p.panelId === panelId);
  if (panels.isLoading) return null;
  if (!panel)
    return (
      <div className="p-8">
        <Empty title="面板不可用">插件可能被禁用、出错，或者没有获得「显示面板」权限。</Empty>
      </div>
    );
  return <PanelFrame panel={panel} workspace={config.data?.workspace ?? null} className="flex h-full flex-col" />;
}
