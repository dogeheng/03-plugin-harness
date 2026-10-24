import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpCircle, Boxes, CheckCircle2, FolderOpen, Lightbulb, Package, PanelRight, Puzzle, ShieldCheck, TerminalSquare, Wrench, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { usePlugins } from "../components/Layout.tsx";
import { PermissionList, StateBadge } from "../components/PluginBits.tsx";
import { confirmDialog } from "../components/Prompts.tsx";
import { Badge, Button, Card, Dialog, Empty, Input, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from "../components/ui.tsx";
import { ApiError, api, type CatalogEntry, errorText, type InspectResult, type PluginSummary } from "../lib/api.ts";
import { permissionLabel } from "../lib/labels.ts";
import { RUNTIME_LABEL } from "../lib/utils.ts";

export function useToggle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api<{ plugin: PluginSummary }>(`/api/plugins/${encodeURIComponent(id)}/${on ? "enable" : "disable"}`, { method: "POST", body: {} }),
    onSuccess: (r, v) => {
      toast.success(`${r.plugin.name} 已${v.on ? "启用" : "禁用"}`);
      void qc.invalidateQueries({ queryKey: ["plugins"] });
      void qc.invalidateQueries({ queryKey: ["plugin", v.id] });
    },
    onError: (e) => toast.error(errorText(e), { description: e instanceof ApiError ? e.hint : undefined }),
  });
}

/** Update with consent for new permissions (the daemon refuses silently-expanding updates). */
export async function updatePlugin(id: string, source: string | undefined, qc: ReturnType<typeof useQueryClient>) {
  const run = (acceptPermissions: boolean) => api<{ plugin: PluginSummary; from: string; to: string; newPermissions: string[] }>(`/api/plugins/${encodeURIComponent(id)}/update`, { body: { source, acceptPermissions } });
  try {
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run(false);
    } catch (e) {
      const added = e instanceof ApiError ? (e.data?.newPermissions as string[] | undefined) : undefined;
      if (!added?.length) throw e;
      const ok = await confirmDialog({
        title: "新版本需要更多权限",
        body: (
          <div className="space-y-2">
            <p>{e instanceof Error ? e.message : ""}</p>
            <ul className="list-disc pl-5">
              {added.map((p) => (
                <li key={p}>
                  {permissionLabel(p)} <span className="font-mono text-[11.5px] text-muted">{p}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted">不同意的话，插件会保持当前版本。</p>
          </div>
        ),
        confirmLabel: "同意并更新",
      });
      if (!ok) return;
      r = await run(true);
    }
    toast.success(`${r.plugin.name} 已从 ${r.from} 更新到 ${r.to}`);
  } catch (e) {
    toast.error(errorText(e), { description: e instanceof ApiError ? e.hint : undefined });
  } finally {
    void qc.invalidateQueries({ queryKey: ["plugins"] });
    void qc.invalidateQueries({ queryKey: ["catalog"] });
    void qc.invalidateQueries({ queryKey: ["plugin", id] });
  }
}

function PluginCard({ p }: { p: PluginSummary }) {
  const toggle = useToggle();
  const c = p.contributes;
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="plugin-card" data-plugin={p.id}>
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent">
          <Puzzle className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/plugins/$id" params={{ id: p.id }} className="text-[14px] font-semibold hover:underline">
              {p.name}
            </Link>
            <span className="text-[12px] text-muted">v{p.version}</span>
            {p.dev && <Badge tone="accent">开发模式</Badge>}
            <StateBadge state={p.state} detail={p.stateDetail} />
          </div>
          <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{p.description}</div>
        </div>
        <Tooltip content={p.enabled ? "禁用：停止进程，它提供的工具、命令和面板全部下线" : "启用：注册它的工具、命令和面板（进程按需启动）"}>
          <span>
            <Switch checked={p.enabled} disabled={toggle.isPending} onCheckedChange={(on) => toggle.mutate({ id: p.id, on })} aria-label={`${p.enabled ? "禁用" : "启用"} ${p.name}`} data-testid="plugin-toggle" />
          </span>
        </Tooltip>
      </div>
      {p.lastError && ["failed", "quarantined", "incompatible"].includes(p.state) && (
        <div className="rounded-[8px] bg-danger-soft px-3 py-2 text-[12px]">
          <div className="text-danger">{p.lastError.message}</div>
          {p.lastError.suggestion && (
            <div className="mt-0.5 flex items-start gap-1 text-fg/80">
              <Lightbulb className="mt-0.5 size-3.5 shrink-0" />
              {p.lastError.suggestion}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        <span className="flex items-center gap-1">
          <Package className="size-3.5" />
          {RUNTIME_LABEL[p.runtime] ?? p.runtime}
        </span>
        {c.tools.length > 0 && (
          <span className="flex items-center gap-1">
            <Wrench className="size-3.5" />
            {c.tools.length} 个工具
          </span>
        )}
        {c.commands.length > 0 && (
          <span className="flex items-center gap-1">
            <TerminalSquare className="size-3.5" />
            {c.commands.map((x) => `/${x}`).join(" ")}
          </span>
        )}
        {c.hooks.length > 0 && (
          <span className="flex items-center gap-1">
            <ShieldCheck className="size-3.5" />
            {c.hooks.length} 个钩子
          </span>
        )}
        {c.panels.length > 0 && (
          <span className="flex items-center gap-1">
            <PanelRight className="size-3.5" />
            {c.panels.map((x) => x.title).join("、")}
          </span>
        )}
        <span className="ml-auto">{p.permissions.filter((x) => x.granted).length} 项权限</span>
      </div>
    </Card>
  );
}

export function InstallDialog({ source: initial, onClose }: { source: string; onClose(): void }) {
  const [source, setSource] = useState(initial);
  const [dev, setDev] = useState(false);
  const [enable, setEnable] = useState(true);
  const [optional, setOptional] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<InspectResult | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();

  const inspect = async (src = source) => {
    setBusy(true);
    setReview(null);
    try {
      const r = await api<InspectResult>("/api/plugins/inspect", { body: { source: src } });
      setReview(r);
      setOptional(new Set());
    } catch (e) {
      toast.error(errorText(e), { description: e instanceof ApiError ? e.hint : undefined });
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    setBusy(true);
    try {
      const r = await api<{ plugin: PluginSummary }>("/api/plugins/install", { body: { source, dev, enable, grantOptional: [...optional] } });
      toast.success(`已安装 ${r.plugin.name} ${r.plugin.version}`);
      await qc.invalidateQueries({ queryKey: ["plugins"] });
      await qc.invalidateQueries({ queryKey: ["catalog"] });
      onClose();
      void navigate({ to: "/plugins/$id", params: { id: r.plugin.id } });
    } catch (e) {
      toast.error(errorText(e), { description: e instanceof ApiError ? e.hint : undefined });
    } finally {
      setBusy(false);
    }
  };

  const m = review?.manifest;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={m ? `安装 ${m.name}` : "安装插件"}
      description={m ? `${m.id} · v${m.version}${m.author?.name ? ` · ${m.author.name}` : ""}` : "安装前会先审查清单和它要求的权限"}
      className="w-[min(680px,calc(100vw-32px))]"
      footer={
        review ? (
          <>
            <label className="mr-auto flex items-center gap-2 text-[12.5px] text-muted">
              <input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} className="accent-[var(--accent)]" />
              安装后立即启用
            </label>
            <Button onClick={() => setReview(null)}>返回</Button>
            <Button variant="primary" disabled={!review.ok || busy} onClick={() => void install()} data-testid="install-confirm">
              {review.existing ? `替换已安装的 ${review.existing.version}` : "同意并安装"}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="primary" disabled={!source.trim() || busy} onClick={() => void inspect()} data-testid="install-inspect">
              {busy ? "正在检查…" : "检查"}
            </Button>
          </>
        )
      }
    >
      {!review ? (
        <div className="space-y-3">
          <div className="text-[12.5px] text-muted">插件目录（包含 harness.plugin.json）、.harnessplugin 文件，或插件中心里列出的名字：</div>
          <Input autoFocus value={source} onChange={(e) => setSource(e.target.value)} placeholder="/Users/you/my-plugin" className="font-mono" onKeyDown={(e) => e.key === "Enter" && void inspect()} data-testid="install-source" />
          <label className="flex items-start gap-2 text-[12.5px]">
            <input type="checkbox" checked={dev} onChange={(e) => setDev(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
            <span>
              开发模式：直接使用这个目录（不复制），文件改动后自动重启插件
              <span className="block text-muted">插件开发者用；等同于 harness plugin dev &lt;目录&gt;</span>
            </span>
          </label>
        </div>
      ) : (
        <div className="space-y-4" data-testid="install-review">
          {m && <div className="text-[13px]">{m.description}</div>}
          {review.errors.length > 0 && (
            <div className="space-y-1.5 rounded-[10px] border border-danger/30 bg-danger-soft p-3 text-[12.5px]">
              <div className="flex items-center gap-1.5 font-medium text-danger">
                <XCircle className="size-4" /> {review.incompatible ? "与当前 Harness 不兼容，无法安装" : "清单有问题，无法安装"}
              </div>
              {review.errors.map((e) => (
                <div key={`${e.code}${e.path}${e.message}`}>
                  {e.path && <span className="font-mono text-[11.5px] text-muted">{e.path} </span>}
                  {e.message}
                  {e.hint && <div className="text-muted">{e.hint}</div>}
                </div>
              ))}
            </div>
          )}
          {review.integrity === "mismatch" && (
            <div className="flex items-center gap-1.5 text-[12.5px] text-danger">
              <AlertTriangle className="size-4" /> 文件与包内校验和不一致，可能被篡改过
            </div>
          )}
          {review.warnings.map((w) => (
            <div key={`${w.code}${w.path}`} className="flex items-start gap-1.5 text-[12.5px] text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {w.message}
            </div>
          ))}
          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-muted">它会怎样运行</div>
            <ul className="space-y-1 text-[12.5px]">
              {review.isolation.map((x) => (
                <li key={x} className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                  {x}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-muted">它要求的权限</div>
            <PermissionList
              mode="review"
              permissions={review.permissions}
              optionalChoice={optional}
              onToggleOptional={(id, on) => {
                const s = new Set(optional);
                if (on) s.add(id);
                else s.delete(id);
                setOptional(s);
              }}
            />
            <div className="mt-1.5 text-[11.5px] text-muted">必需权限会在安装时授予；可选权限可以现在勾选，也可以等插件用到时再决定。之后都能在插件详情页撤销。</div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function PluginsPage() {
  const plugins = usePlugins();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => api<{ entries: CatalogEntry[] }>("/api/catalog").then((r) => r.entries) });
  const [installing, setInstalling] = useState<string | null>(null);
  const qc = useQueryClient();
  const list = plugins.data?.plugins ?? [];
  const discover = (catalog.data ?? []).filter((e) => !e.installed);
  const updates = (catalog.data ?? []).filter((e) => e.updateAvailable);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[980px] px-8 py-7">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex-1">
            <h1 className="text-[20px] font-semibold">插件</h1>
            <p className="text-[12.5px] text-muted">Agent 的所有工具、命令、钩子和面板都由插件提供。每个插件运行在独立的受限进程里，只能做你授权过的事。</p>
          </div>
          <Button variant="primary" onClick={() => setInstalling("")} data-testid="install-open">
            <FolderOpen /> 从文件夹安装…
          </Button>
        </div>
        {plugins.data?.safeMode && (
          <div className="mb-4 flex items-center gap-2 rounded-[10px] border border-warning/40 bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
            <AlertTriangle className="size-4" /> 安全模式：所有插件都没有加载。重启 daemon（不带 --safe-mode）即可恢复。
          </div>
        )}
        <Tabs defaultValue="installed">
          <TabsList>
            <TabsTrigger value="installed">已安装 {list.length > 0 && <span className="text-muted">{list.length}</span>}</TabsTrigger>
            <TabsTrigger value="discover">发现 {discover.length > 0 && <span className="text-muted">{discover.length}</span>}</TabsTrigger>
            <TabsTrigger value="updates">更新 {updates.length > 0 && <Badge tone="accent">{updates.length}</Badge>}</TabsTrigger>
          </TabsList>
          <TabsContent value="installed" className="mt-4">
            {list.length === 0 ? (
              <Empty icon={<Boxes />} title="还没有安装插件">
                到「发现」看看本机插件目录里的插件，或者从文件夹安装你自己写的插件。
              </Empty>
            ) : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {list.map((p) => (
                  <PluginCard key={p.id} p={p} />
                ))}
              </div>
            )}
          </TabsContent>
          <TabsContent value="discover" className="mt-4">
            {discover.length === 0 ? (
              <Empty icon={<Boxes />} title="插件目录里的插件都已安装">
                插件目录：仓库的 plugins/、配置中的 catalogs，以及环境变量 HARNESS_CATALOG。
              </Empty>
            ) : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {discover.map((e) => (
                  <Card key={e.id} className="flex items-start gap-3 p-4" data-testid="catalog-card" data-plugin={e.id}>
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-bg-subtle text-muted">
                      <Puzzle className="size-4.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14px] font-semibold">{e.name}</span>
                        <span className="text-[12px] text-muted">v{e.version}</span>
                        <Badge>{RUNTIME_LABEL[e.runtime] ?? e.runtime}</Badge>
                      </div>
                      <div className="mt-0.5 text-[12.5px] text-muted">{e.description}</div>
                      {!e.valid && <div className="mt-1 text-[12px] text-danger">{e.problems.join("；")}</div>}
                    </div>
                    <Button size="sm" variant="primary" disabled={!e.valid} onClick={() => setInstalling(e.dir)}>
                      安装…
                    </Button>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
          <TabsContent value="updates" className="mt-4">
            {updates.length === 0 ? (
              <Empty icon={<ArrowUpCircle />} title="所有插件都是最新的" />
            ) : (
              <div className="space-y-2">
                {updates.map((e) => (
                  <Card key={e.id} className="flex items-center gap-3 p-4">
                    <ArrowUpCircle className="size-5 text-accent" />
                    <div className="flex-1">
                      <div className="font-medium">{e.name}</div>
                      <div className="text-[12px] text-muted">
                        {e.installed} → {e.version}
                      </div>
                    </div>
                    <Button size="sm" variant="primary" onClick={() => void updatePlugin(e.id, e.dir, qc)}>
                      更新
                    </Button>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
      {installing !== null && <InstallDialog key={installing} source={installing} onClose={() => setInstalling(null)} />}
    </div>
  );
}
