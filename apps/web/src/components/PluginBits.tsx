import { ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import type { PermissionView, PluginState } from "../lib/api.ts";
import { cn, RISK_META, STATE_META } from "../lib/utils.ts";
import { Badge, Button, Dot, Tooltip } from "./ui.tsx";

export function StateBadge({ state, detail, className }: { state: PluginState; detail?: string | null; className?: string }) {
  const meta = STATE_META[state] ?? { label: state, tone: "muted" as const };
  const tip = detail || meta.hint;
  const badge = (
    <Badge tone={meta.tone} className={cn("gap-1.5", className)} data-state={state} data-testid="plugin-state">
      <Dot tone={meta.tone} pulse={state === "activating"} />
      {meta.label}
    </Badge>
  );
  return tip ? <Tooltip content={tip}>{badge}</Tooltip> : badge;
}

/**
 * Permission rows as shown before install (review) and on the detail page (manage).
 * Wording is user-facing: what it can do, where, and why the plugin says it needs it.
 */
export function PermissionList({
  permissions,
  mode,
  optionalChoice,
  onToggleOptional,
  onRevoke,
  onGrant,
  busy,
}: {
  permissions: PermissionView[];
  mode: "review" | "manage";
  optionalChoice?: Set<string>;
  onToggleOptional?(id: string, on: boolean): void;
  onRevoke?(p: PermissionView): void;
  onGrant?(p: PermissionView): void;
  busy?: string | null;
}) {
  if (!permissions.length)
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-border bg-bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
        <ShieldCheck className="size-4 text-success" /> 这个插件不需要任何权限。
      </div>
    );
  const sorted = [...permissions].sort((a, b) => Number(b.required) - Number(a.required));
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-[10px] border border-border" data-testid="permission-list">
      {sorted.map((p) => {
        const risk = RISK_META[p.risk] ?? RISK_META.low;
        const Icon = p.risk === "high" ? ShieldAlert : p.granted || mode === "review" ? ShieldCheck : ShieldOff;
        return (
          <li key={p.id} className="flex items-start gap-3 bg-card px-3 py-2.5" data-permission={p.id}>
            <Icon className={cn("mt-0.5 size-4 shrink-0", p.risk === "high" ? "text-danger" : p.risk === "medium" ? "text-warning" : "text-muted")} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{p.label}</span>
                <Badge tone={risk.tone}>{risk.label}</Badge>
                {!p.required && <Badge>可选</Badge>}
                {mode === "manage" && (p.granted ? <Badge tone="success">已授予</Badge> : <Badge tone="warning">未授予</Badge>)}
                <span className="font-mono text-[11px] text-muted">{p.id}</span>
              </div>
              {p.scopeText && <div className="mt-0.5 break-all font-mono text-[11.5px] text-fg/80">{p.scopeText}</div>}
              <div className="mt-0.5 text-[12px] text-muted">
                {p.explain}
                {p.reason && <span className="text-fg/80"> · 插件说明：{p.reason}</span>}
              </div>
            </div>
            {mode === "review" && !p.required && onToggleOptional && (
              <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
                <input type="checkbox" className="accent-[var(--accent)]" checked={optionalChoice?.has(p.id) ?? false} onChange={(e) => onToggleOptional(p.id, e.target.checked)} />
                现在授予
              </label>
            )}
            {mode === "manage" && p.granted && onRevoke && (
              <Button size="sm" variant="danger-ghost" disabled={busy === p.id} onClick={() => onRevoke(p)}>
                撤销
              </Button>
            )}
            {mode === "manage" && !p.granted && onGrant && (
              <Button size="sm" disabled={busy === p.id} onClick={() => onGrant(p)}>
                授予
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
