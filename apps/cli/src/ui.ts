import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";

export const dim = (s: string) => styleText("dim", s);
export const red = (s: string) => styleText("red", s);
export const green = (s: string) => styleText("green", s);
export const yellow = (s: string) => styleText("yellow", s);
export const cyan = (s: string) => styleText("cyan", s);
export const bold = (s: string) => styleText("bold", s);

export function short(v: unknown, max = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const interactive = () => !!process.stdin.isTTY && !!process.stderr.isTTY;

/** Yes/no question on stderr. Non-interactive sessions get the default. */
export async function confirm(question: string, def = false): Promise<boolean> {
  if (!interactive()) return def;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`${yellow("?")} ${question} ${dim(def ? "[Y/n]" : "[y/N]")} `)).trim();
    return a ? /^y(es)?$/i.test(a) : def;
  } finally {
    rl.close();
  }
}

/** Single-letter choice, e.g. [o]nce / [a]lways / [d]eny. */
export async function choose<T extends string>(question: string, options: Array<{ key: string; value: T; label: string }>, def: T): Promise<T> {
  if (!interactive()) return def;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const legend = options.map((o) => `${bold(o.key)} ${o.label}`).join(" / ");
    for (;;) {
      const a = (await rl.question(`${yellow("?")} ${question}\n  ${legend} ${dim(`（回车 = ${options.find((o) => o.value === def)?.label}）`)} `)).trim().toLowerCase();
      if (!a) return def;
      const hit = options.find((o) => o.key === a || o.value === a);
      if (hit) return hit.value;
    }
  } finally {
    rl.close();
  }
}

export const riskTag = (risk: string) => (risk === "high" ? red("[高风险]") : risk === "medium" ? yellow("[中风险]") : dim("[低风险]"));

export function stateBadge(state: string): string {
  switch (state) {
    case "active":
      return green("● 运行中");
    case "enabled":
    case "idle":
      return cyan("○ 已启用");
    case "activating":
      return cyan("◌ 启动中");
    case "disabled":
      return dim("◌ 已禁用");
    case "failed":
      return red("✗ 失败");
    case "quarantined":
      return red("⛔ 已隔离");
    case "incompatible":
      return red("✗ 不兼容");
    case "invalid":
      return red("✗ 无效");
    default:
      return state;
  }
}

/** Prints an API/Harness error with its hint and issue list. */
export function printError(err: unknown, out: NodeJS.WritableStream = process.stderr): void {
  const e = err as { message?: string; body?: { error?: { message?: string; hint?: string; data?: Record<string, unknown> } } };
  const info = e?.body?.error;
  out.write(`${red("✗")} ${info?.message ?? e?.message ?? String(err)}\n`);
  const issues = (info?.data?.issues ?? []) as Array<{ path?: string; message: string; hint?: string }>;
  for (const i of issues) out.write(`  ${red("·")} ${i.path && i.path !== "/" ? dim(`${i.path} `) : ""}${i.message}${i.hint ? dim(`\n      → ${i.hint}`) : ""}\n`);
  const hint = info?.hint ?? (info?.data?.hint as string | undefined);
  if (hint) out.write(`  ${dim("→")} ${hint}\n`);
}
