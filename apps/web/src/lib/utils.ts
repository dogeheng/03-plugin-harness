import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { PermissionView, PluginState } from "./api.ts";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86_400 * 30) return `${Math.round(s / 86_400)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Health colours (report 8.2): running green, idle grey, degraded amber, quarantined red. */
export type Tone = "success" | "muted" | "warning" | "danger" | "accent";

export const STATE_META: Record<PluginState, { label: string; tone: Tone; hint?: string }> = {
  active: { label: "运行中", tone: "success" },
  idle: { label: "空闲", tone: "muted", hint: "进程已回收，下次使用时自动启动" },
  enabled: { label: "已启用", tone: "muted", hint: "按需启动：第一次被使用时才会运行" },
  activating: { label: "启动中", tone: "accent" },
  updating: { label: "更新中", tone: "accent" },
  failed: { label: "出错", tone: "warning" },
  quarantined: { label: "已隔离", tone: "danger", hint: "短时间内反复崩溃，宿主已停止调用它" },
  incompatible: { label: "不兼容", tone: "danger" },
  disabled: { label: "已禁用", tone: "muted" },
  installed: { label: "已安装", tone: "muted" },
  validated: { label: "已校验", tone: "muted" },
  discovered: { label: "可安装", tone: "muted" },
  rejected: { label: "已拒绝", tone: "danger" },
};

export const RISK_META: Record<PermissionView["risk"], { label: string; tone: Tone }> = {
  none: { label: "无风险", tone: "muted" },
  low: { label: "低风险", tone: "muted" },
  medium: { label: "中风险", tone: "warning" },
  high: { label: "高风险", tone: "danger" },
};

export const TOOL_RISK_LABEL: Record<string, string> = { read: "只读", write: "写入", exec: "执行", network: "联网" };

export const RUNTIME_LABEL: Record<string, string> = { node: "Node 进程", python: "Python 进程", wasm: "WebAssembly", none: "声明式" };
