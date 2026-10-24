import { resolve } from "node:path";
import type { Command } from "commander";
import { ApiError, type DaemonClient, ensureDaemon } from "./client.ts";
import { bold, choose, confirm, cyan, dim, green, interactive, printError, red, riskTag, short, stateBadge, yellow } from "./ui.ts";

export interface CommandContext {
  fail(err: unknown): never;
}

interface PermissionView {
  id: string;
  label: string;
  risk: string;
  explain: string;
  scopeText: string;
  reason: string;
  required: boolean;
  granted: boolean;
}
interface Failure {
  phase?: string;
  message: string;
  action?: string;
  suggestion?: string;
  at?: string;
}
interface Summary {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime: string;
  dev: boolean;
  source: string;
  enabled: boolean;
  state: string;
  stateDetail: string | null;
  lastError: Failure | null;
  contributes: { tools: string[]; commands: string[]; hooks: string[]; panels: Array<{ id: string; title: string }>; skills: boolean };
  permissions: PermissionView[];
  stats: { activations: number; calls: number; errors: number; timeouts: number; totalMs: number } | null;
  isolation: string[];
  pid: number | null;
}
type ContribItem = { name?: string; event?: string; title?: string };
interface Inspect {
  source: string;
  kind: string;
  ok: boolean;
  errors: Array<{ path: string; message: string; hint?: string }>;
  warnings: Array<{ path: string; message: string; hint?: string }>;
  incompatible: boolean;
  integrity: "ok" | "mismatch" | "none";
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string | { name: string };
    runtime: { type: string };
    contributes?: Record<string, ContribItem[] | unknown>;
  } | null;
  existing: { version: string; dev: boolean } | null;
  permissions: PermissionView[];
  isolation: string[];
}
export interface ActionView {
  id: string;
  label: string;
  path: string;
  mode: "create" | "overwrite" | "prepend";
  bytes: number;
  exists: boolean;
}
export interface CommandResult {
  markdown?: string;
  content?: Array<{ type: string; text?: string }>;
  actions?: ActionView[];
  actionProblems?: string[];
  pluginId: string;
}

const out = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));
const enc = encodeURIComponent;

async function client(): Promise<DaemonClient> {
  return ensureDaemon({ quiet: true });
}

/** Accepts the full id, the last id segment ("git-insight") or the display name. */
async function resolveId(c: DaemonClient, ref: string): Promise<string> {
  const { plugins } = await c.json<{ plugins: Summary[] }>("GET", "/api/plugins");
  const low = ref.toLowerCase();
  const hit = plugins.find((p) => p.id === ref) ?? plugins.find((p) => p.id.split(".").pop() === low || p.name.toLowerCase() === low);
  if (hit) return hit.id;
  const message = `没有安装插件 ${ref}`;
  const hint = `已安装：${plugins.map((p) => p.id).join("、") || "（无）"}。运行 harness plugin catalog 查看可安装的插件`;
  throw new ApiError(404, message, { error: { message, data: { hint } } });
}

/** Wraps an action: errors are printed with hints and set a non-zero exit code. */
// commander passes heterogenous arguments
function run(fn: (...a: any[]) => Promise<void>) {
  // see above
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      printError(err);
      process.exitCode = 1;
    }
  };
}

function contributesLine(cn: Summary["contributes"]): string {
  const parts: string[] = [];
  if (cn.tools.length) parts.push(`工具 ${cn.tools.join(", ")}`);
  if (cn.commands.length) parts.push(`命令 ${cn.commands.map((c) => `/${c}`).join(", ")}`);
  if (cn.hooks.length) parts.push(`钩子 ${cn.hooks.join(", ")}`);
  if (cn.panels.length) parts.push(`面板 ${cn.panels.map((p) => p.title).join(", ")}`);
  if (cn.skills) parts.push("技能");
  return parts.join(" · ") || "（没有声明任何能力）";
}

function printPermissions(perms: PermissionView[], mode: "review" | "status"): void {
  const req = perms.filter((p) => p.required);
  const opt = perms.filter((p) => !p.required);
  const line = (p: PermissionView) => {
    const mark = mode === "review" ? (p.required ? "●" : "○") : p.granted ? green("✓") : dim("·");
    out(`    ${mark} ${bold(p.label)} ${dim(p.id)} ${riskTag(p.risk)}${p.scopeText ? `  ${p.scopeText}` : ""}`);
    out(dim(`      ${p.reason || p.explain}`));
  };
  if (!perms.length) out(dim("  不需要任何权限"));
  if (req.length) {
    out(mode === "review" ? "  安装即授予的权限：" : "  必需权限：");
    req.forEach(line);
  }
  if (opt.length) {
    out(mode === "review" ? "  可选权限（默认不授予，可随时用 harness plugin grant 开启）：" : "  可选权限：");
    opt.forEach(line);
  }
}

function printFailure(f: Failure | null, indent = "  "): void {
  if (!f) return;
  out(`${indent}${red("✗")} ${f.message}${f.at ? dim(`（${f.at.replace("T", " ").slice(0, 19)}）`) : ""}`);
  if (f.action) out(`${indent}  ${dim("宿主已处理：")}${f.action}`);
  if (f.suggestion) out(`${indent}  ${dim("建议：")}${f.suggestion}`);
}

function printReview(r: Inspect): void {
  const m = r.manifest;
  if (!m) out(red("✗ 无法读取插件清单"));
  else {
    out(`${bold(m.name)} ${m.version}  ${dim(m.id)}`);
    out(`  ${m.description}`);
    const author = typeof m.author === "string" ? m.author : m.author?.name;
    out(dim(`  运行方式 ${m.runtime.type}${author ? ` · 作者 ${author}` : ""} · 来源 ${r.source}`));
    const list = (k: string) => (Array.isArray(m.contributes?.[k]) ? (m.contributes?.[k] as ContribItem[]) : []);
    const parts = [
      list("tools").length && `工具 ${list("tools").map((x) => x.name).join(", ")}`,
      list("commands").length && `命令 ${list("commands").map((x) => `/${x.name}`).join(", ")}`,
      list("hooks").length && `钩子 ${list("hooks").map((x) => x.event).join(", ")}`,
      list("panels").length && `面板 ${list("panels").map((x) => x.title).join(", ")}`,
    ].filter(Boolean);
    out(`  提供：${parts.join(" · ") || "（无）"}`);
    if (r.isolation.length) {
      out("  隔离：");
      for (const i of r.isolation) out(dim(`    · ${i}`));
    }
    printPermissions(r.permissions, "review");
  }
  if (r.integrity === "ok") out(green("  ✓ 文件校验和一致"));
  if (r.integrity === "mismatch") out(red("  ✗ 文件校验和不匹配：插件包可能被篡改"));
  if (r.existing) out(yellow(`  ! 已安装版本 ${r.existing.version}${r.existing.dev ? "（开发模式）" : ""}`));
  for (const w of r.warnings) out(`  ${yellow("!")} ${w.message}${w.hint ? dim(` → ${w.hint}`) : ""}`);
  for (const e of r.errors) out(`  ${red("✗")} ${e.path && e.path !== "/" ? dim(`${e.path} `) : ""}${e.message}${e.hint ? dim(`\n      → ${e.hint}`) : ""}`);
  if (r.incompatible) out(red("  ✗ 与当前 Harness 版本不兼容"));
}

const BAD_STATES = ["failed", "quarantined", "incompatible", "invalid"];

function printSummaryLine(p: Summary): void {
  out(`${stateBadge(p.state)}  ${bold(p.name)} ${p.version}${p.dev ? yellow(" [dev]") : ""}  ${dim(p.id)}`);
  out(dim(`    ${contributesLine(p.contributes)}`));
  if (BAD_STATES.includes(p.state)) {
    if (p.stateDetail) out(`    ${red(p.stateDetail)}`);
    printFailure(p.lastError, "    ");
  } else if (p.stateDetail && p.state !== "active") out(dim(`    ${p.stateDetail}`));
}

/** Prints a command result and lets the user confirm host-side actions. */
export async function renderCommandResult(c: DaemonClient, r: CommandResult, opts: { apply?: boolean; json?: boolean } = {}): Promise<void> {
  if (opts.json) return json(r);
  const text = r.markdown ?? (r.content ?? []).map((b) => b.text ?? "").join("\n");
  if (text) out(text.trimEnd());
  for (const p of r.actionProblems ?? []) out(`${yellow("!")} ${p}`);
  for (const a of r.actions ?? []) {
    const how = a.mode === "prepend" ? (a.exists ? "插入到现有内容前面" : "新建") : a.mode === "overwrite" ? (a.exists ? "覆盖现有文件" : "新建") : "新建";
    const yes = opts.apply || (interactive() && (await confirm(`${a.label}？（${a.path}，${how}，${a.bytes} 字节）`, false)));
    if (!yes) {
      out(dim(`  未执行：${a.label}${interactive() ? "" : "（非交互模式，加 --apply 可直接执行）"}`));
      continue;
    }
    const res = await c.json<{ applied: { path: string; absPath: string; bytes: number } }>("POST", `/api/actions/${a.id}/apply`);
    out(`${green("✓")} 已写入 ${res.applied.absPath}`);
  }
}

/** Answers a runtime permission prompt raised while a plugin runs. */
export async function answerPermission(
  c: DaemonClient,
  e: { requestId: string; pluginId: string; pluginName?: string; label?: string; permission: string; risk?: string; scope?: string; reason?: string },
  mode: "ask" | "yes" | "no",
): Promise<string> {
  let decision: "once" | "always" | "deny" = mode === "yes" ? "once" : "deny";
  if (mode === "ask" && interactive()) {
    process.stderr.write(`\n${yellow("?")} 插件 ${bold(e.pluginName ?? e.pluginId)} 请求权限「${e.label ?? e.permission}」${e.risk ? ` ${riskTag(e.risk)}` : ""}${e.scope ? `  范围：${e.scope}` : ""}\n`);
    if (e.reason) process.stderr.write(dim(`  理由：${e.reason}\n`));
    decision = await choose(
      "是否允许？",
      [
        { key: "o", value: "once", label: "仅这次" },
        { key: "a", value: "always", label: "始终允许" },
        { key: "d", value: "deny", label: "拒绝" },
      ],
      "deny",
    );
  }
  await c.json("POST", `/api/prompts/${e.requestId}`, { decision });
  return decision === "once" ? "已允许（仅这次）" : decision === "always" ? "已始终允许（可用 harness plugin revoke 撤销）" : "已拒绝";
}

export async function answerConfirm(c: DaemonClient, e: { requestId: string; pluginId: string; pluginName?: string; message: string }, mode: "ask" | "yes" | "no"): Promise<string> {
  const yes = mode === "ask" ? await confirm(`插件 ${e.pluginName ?? e.pluginId}：${e.message}`, false) : mode === "yes";
  await c.json("POST", `/api/prompts/${e.requestId}`, { decision: yes ? "once" : "deny" });
  return yes ? "已确认" : "已拒绝";
}

/** Runs a plugin slash command (shared by `harness run` and the chat REPL). */
export async function runSlashCommand(
  c: DaemonClient,
  line: string,
  opts: { workspace?: string; sessionId?: string; apply?: boolean; json?: boolean; approve?: "ask" | "yes" | "no" } = {},
): Promise<void> {
  const [head, ...args] = splitArgs(line.trim());
  const name = (head ?? "").replace(/^\//, "");
  type StreamEvent =
    | { type: "command.result"; result: CommandResult }
    | { type: "command.error"; error: { code: number; message: string; data?: unknown } }
    | { type: "permission.request"; requestId: string; pluginId: string; pluginName?: string; permission: string; label?: string; risk?: string; scope?: string; reason?: string }
    | { type: "confirm.request"; requestId: string; pluginId: string; pluginName?: string; message: string }
    | { type: string };
  const body = { args, workspace: resolve(opts.workspace ?? process.cwd()), sessionId: opts.sessionId };
  for await (const e of c.stream<StreamEvent>(`/api/commands/${enc(name)}`, body)) {
    const mode = opts.approve ?? "ask";
    if (e.type === "permission.request") out(dim(`  ${await answerPermission(c, e as Extract<StreamEvent, { type: "permission.request" }>, mode)}`));
    else if (e.type === "confirm.request") out(dim(`  ${await answerConfirm(c, e as Extract<StreamEvent, { type: "confirm.request" }>, mode)}`));
    else if (e.type === "command.error") {
      const err = (e as Extract<StreamEvent, { type: "command.error" }>).error;
      throw new ApiError(400, err.message, { error: err });
    } else if (e.type === "command.result") await renderCommandResult(c, (e as Extract<StreamEvent, { type: "command.result" }>).result, opts);
  }
}

export function registerPluginCommands(program: Command, _ctx: CommandContext): void {
  const plugin = program.command("plugin").alias("plugins").description("安装、查看、配置和管理插件");

  plugin
    .command("catalog")
    .description("列出可安装的插件（内置目录、配置中的 catalogs 与 HARNESS_CATALOG）")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (o: { json?: boolean }) => {
        const c = await client();
        const { entries } = await c.json<{ entries: Array<{ id: string; name: string; version: string; description: string; runtime: string; installed: string | null; updateAvailable: boolean; valid: boolean; problems: string[] }> }>("GET", "/api/catalog");
        if (o.json) return json(entries);
        if (!entries.length) return out(dim("目录中没有插件"));
        for (const e of entries) {
          const tag = e.updateAvailable ? yellow(`可更新 ${e.installed} → ${e.version}`) : e.installed ? green(`已安装 ${e.installed}`) : !e.valid ? red("清单无效") : cyan("可安装");
          out(`${bold(e.name)} ${e.version}  ${dim(e.id)}  ${tag}`);
          out(dim(`    ${e.description} · ${e.runtime}`));
          for (const p of e.problems) out(`    ${red("·")} ${p}`);
        }
        out(dim("\n安装前审查：harness plugin inspect <名字或目录>    安装：harness plugin install <名字或目录>"));
      }),
    );

  plugin
    .command("inspect <source>")
    .description("安装前审查插件：能力、权限、隔离方式（不会执行插件代码）")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (source: string, o: { json?: boolean }) => {
        const c = await client();
        const r = await c.json<Inspect>("POST", "/api/plugins/inspect", { source: absIfPath(source) });
        if (o.json) return json(r);
        printReview(r);
        if (!r.ok) process.exitCode = 1;
      }),
    );

  plugin
    .command("install <source>")
    .description("安装插件（目录、.harnessplugin 文件或目录中的名字）")
    .option("--dev", "开发模式：直接使用源码目录，改动后自动重启")
    .option("-y, --yes", "不再询问，接受必需权限")
    .option("--grant <permissions...>", "同时授予的可选权限")
    .option("--disabled", "安装后先不启用")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (source: string, o: { dev?: boolean; yes?: boolean; grant?: string[]; disabled?: boolean; json?: boolean }) => {
        const c = await client();
        const src = absIfPath(source);
        const review = await c.json<Inspect>("POST", "/api/plugins/inspect", { source: src });
        if (!o.json) printReview(review);
        const devReinstall = o.dev && review.existing?.dev;
        if (!review.ok && !devReinstall) {
          process.exitCode = 1;
          return;
        }
        if (review.existing && !devReinstall) {
          out(yellow(`\n! 已安装 ${review.existing.version}。更新请运行 harness plugin update ${review.manifest?.id}`));
          process.exitCode = 1;
          return;
        }
        const grant = new Set(o.grant ?? []);
        if (!o.yes) {
          if (!interactive()) throw new Error("非交互模式下安装需要加 --yes（表示你已审查并接受上面的必需权限）");
          if (!(await confirm(`安装 ${review.manifest?.name} 并授予上面的必需权限？`, true))) return out(dim("已取消"));
          for (const p of review.permissions.filter((x) => !x.required && !grant.has(x.id))) if (await confirm(`同时授予可选权限「${p.label}」？`, false)) grant.add(p.id);
        }
        const { plugin: s } = await c.json<{ plugin: Summary }>("POST", "/api/plugins/install", { source: src, dev: o.dev, enable: !o.disabled, grantOptional: [...grant] });
        if (o.json) return json(s);
        out(`${green("✓")} 已安装 ${bold(s.name)} ${s.version}${s.dev ? yellow("（开发模式，修改代码后自动重启）") : ""}`);
        out(dim(`  ${contributesLine(s.contributes)}`));
        if (s.contributes.commands.length) out(dim(`  试试：harness run /${s.contributes.commands[0]}`));
        if (s.contributes.tools.length) out(dim('  或在对话中使用：harness chat "…"'));
      }),
    );

  plugin
    .command("list")
    .alias("ls")
    .description("列出已安装的插件和状态")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (o: { json?: boolean }) => {
        const c = await client();
        const r = await c.json<{ plugins: Summary[]; safeMode: boolean }>("GET", "/api/plugins");
        if (o.json) return json(r);
        if (r.safeMode) out(yellow("! 安全模式：所有插件都没有加载（去掉 HARNESS_SAFE_MODE=1 后重启 harnessd 即可恢复）\n"));
        if (!r.plugins.length) return out(dim("还没有安装插件。运行 harness plugin catalog 查看可安装的插件"));
        for (const p of r.plugins) printSummaryLine(p);
      }),
    );

  plugin
    .command("info <plugin>")
    .description("查看插件详情：状态、权限、设置、最近的错误")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (ref: string, o: { json?: boolean }) => {
        const c = await client();
        const id = await resolveId(c, ref);
        type Detail = Summary & {
          settings: Record<string, unknown>;
          secretKeys: string[];
          secretsConfigured: Record<string, boolean>;
          dir: string;
          versions: Array<{ version: string; verified: string }>;
          issues: Array<{ message: string; hint?: string }>;
        };
        const d = await c.json<Detail>("GET", `/api/plugins/${enc(id)}`);
        if (o.json) return json(d);
        out(`${bold(d.name)} ${d.version}  ${dim(d.id)}  ${stateBadge(d.state)}${d.pid ? dim(` pid ${d.pid}`) : ""}`);
        out(`  ${d.description}`);
        if (d.stateDetail) out(dim(`  ${d.stateDetail}`));
        printFailure(d.lastError);
        for (const i of d.issues) out(`  ${red("·")} ${i.message}${i.hint ? dim(` → ${i.hint}`) : ""}`);
        out(`  提供：${contributesLine(d.contributes)}`);
        out(dim(`  运行方式 ${d.runtime}${d.dev ? "（开发模式）" : ""} · 目录 ${d.dir}`));
        for (const i of d.isolation) out(dim(`  隔离：${i}`));
        const s = d.stats;
        if (s) out(dim(`  统计：启动 ${s.activations} 次 · 调用 ${s.calls} 次 · 失败 ${s.errors} · 超时 ${s.timeouts}${s.calls ? ` · 平均 ${Math.round(s.totalMs / s.calls)}ms` : ""}`));
        printPermissions(d.permissions, "status");
        const keys = Object.keys(d.settings);
        if (keys.length || d.secretKeys.length) {
          out("  设置：");
          for (const k of keys) out(`    ${k} = ${JSON.stringify(d.settings[k])}`);
          for (const k of d.secretKeys) out(`    ${k} = ${d.secretsConfigured[k] ? green("已保存在钥匙串") : yellow("未设置")}  ${dim(`harness plugin secret ${ref} ${k}`)}`);
        }
        if (d.versions.length > 1) out(dim(`  已保存的版本：${d.versions.map((v) => v.version).join("、")}（可用 harness plugin rollback ${ref} 回滚）`));
      }),
    );

  const simple: Array<[string, string, string]> = [
    ["enable", "启用插件（也用于恢复被隔离的插件）", "已启用"],
    ["disable", "禁用插件（进程会被停止，工具和钩子立即失效）", "已禁用"],
    ["restart", "重启插件进程", "已重启"],
  ];
  for (const [name, desc, verb] of simple) {
    plugin
      .command(`${name} <plugin>`)
      .description(desc)
      .action(
        run(async (ref: string) => {
          const c = await client();
          const id = await resolveId(c, ref);
          const { plugin: s } = await c.json<{ plugin: Summary }>("POST", `/api/plugins/${enc(id)}/${name}`);
          out(`${green("✓")} ${verb} ${s.name}  ${stateBadge(s.state)}`);
        }),
      );
  }

  plugin
    .command("update <plugin> [source]")
    .description("更新到目录中的新版本（或指定来源）；授权、设置和数据会保留")
    .option("--accept-permissions", "接受新版本新增的必需权限")
    .action(
      run(async (ref: string, source: string | undefined, o: { acceptPermissions?: boolean }) => {
        const c = await client();
        const id = await resolveId(c, ref);
        type R = { plugin: Summary; from: string; to: string; newPermissions: string[] };
        const call = (accept: boolean) => c.json<R>("POST", `/api/plugins/${enc(id)}/update`, { source: source ? absIfPath(source) : undefined, acceptPermissions: accept });
        let r: R;
        try {
          r = await call(!!o.acceptPermissions);
        } catch (err) {
          const added = ((err as ApiError).body as { error?: { data?: { newPermissions?: string[] } } } | undefined)?.error?.data?.newPermissions;
          if (!added || !interactive()) throw err;
          printError(err, process.stdout);
          if (!(await confirm("接受这些新权限并更新？", false))) return out(dim("已取消，继续使用旧版本"));
          r = await call(true);
        }
        out(`${green("✓")} ${r.plugin.name} 已从 ${r.from} 更新到 ${r.to}${r.newPermissions.length ? `，新增权限：${r.newPermissions.join("、")}` : ""}`);
        out(dim(`  有问题可以回滚：harness plugin rollback ${ref}`));
      }),
    );

  plugin
    .command("rollback <plugin>")
    .description("回滚到上一个安装的版本")
    .action(
      run(async (ref: string) => {
        const c = await client();
        const id = await resolveId(c, ref);
        const r = await c.json<{ plugin: Summary; from: string; to: string }>("POST", `/api/plugins/${enc(id)}/rollback`);
        out(`${green("✓")} ${r.plugin.name} 已从 ${r.from} 回滚到 ${r.to}`);
      }),
    );

  plugin
    .command("uninstall <plugin>")
    .alias("remove")
    .description("卸载插件（同时删除它的数据、设置和钥匙串中的密钥）")
    .option("--keep-data", "保留插件数据，便于以后重新安装")
    .option("-y, --yes", "不再询问")
    .action(
      run(async (ref: string, o: { keepData?: boolean; yes?: boolean }) => {
        const c = await client();
        const id = await resolveId(c, ref);
        if (!o.yes) {
          if (!interactive()) throw new Error("非交互模式下卸载需要加 --yes");
          if (!(await confirm(`卸载 ${id}${o.keepData ? "（保留数据）" : "，并删除它的数据和密钥"}？`, false))) return out(dim("已取消"));
        }
        await c.json("DELETE", `/api/plugins/${enc(id)}${o.keepData ? "?keepData=1" : ""}`);
        out(`${green("✓")} 已卸载 ${id}`);
      }),
    );

  plugin
    .command("config <plugin> [assignments...]")
    .description("查看或修改设置，例如 harness plugin config git-insight maxCommits=50")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (ref: string, assignments: string[], o: { json?: boolean }) => {
        const c = await client();
        const id = await resolveId(c, ref);
        type Prop = { description?: string; enum?: unknown[]; "x-secret"?: boolean };
        const d = await c.json<{ settings: Record<string, unknown>; manifest: { configSchema?: { properties?: Record<string, Prop> } } }>("GET", `/api/plugins/${enc(id)}`);
        if (assignments.length) {
          const values: Record<string, unknown> = {};
          for (const a of assignments) {
            const eq = a.indexOf("=");
            if (eq <= 0) throw new Error(`无法解析「${a}」，格式是 key=value`);
            values[a.slice(0, eq)] = parseValue(a.slice(eq + 1));
          }
          const r = await c.json<{ settings: Record<string, unknown> }>("PUT", `/api/plugins/${enc(id)}/settings`, { values });
          if (o.json) return json(r.settings);
          for (const k of Object.keys(values)) out(`${green("✓")} ${k} = ${JSON.stringify(r.settings[k])}`);
          return;
        }
        if (o.json) return json(d.settings);
        const props = d.manifest.configSchema?.properties ?? {};
        if (!Object.keys(props).length) return out(dim("这个插件没有可配置的设置"));
        for (const [k, s] of Object.entries(props)) {
          if (s["x-secret"]) out(`${bold(k)} ${dim("（密钥，保存在钥匙串）")}  harness plugin secret ${ref} ${k}`);
          else out(`${bold(k)} = ${JSON.stringify(d.settings[k])}${s.enum ? dim(`  可选：${s.enum.join(" | ")}`) : ""}`);
          if (s.description) out(dim(`    ${s.description}`));
        }
      }),
    );

  plugin
    .command("secret <plugin> <key>")
    .description("把插件的密钥保存到 macOS 钥匙串（隐藏输入，或从标准输入读取）")
    .option("--remove", "删除这个密钥")
    .action(
      run(async (ref: string, key: string, o: { remove?: boolean }) => {
        const c = await client();
        const id = await resolveId(c, ref);
        const path = `/api/plugins/${enc(id)}/secrets/${enc(key)}`;
        if (o.remove) {
          await c.json("DELETE", path);
          return out(`${green("✓")} 已删除 ${key}`);
        }
        let value: string;
        if (process.stdin.isTTY) {
          const { password, isCancel } = await import("@clack/prompts");
          const v = await password({ message: `${id} 的 ${key}` });
          if (isCancel(v) || !v) return out(dim("已取消"));
          value = v;
        } else {
          const chunks: Buffer[] = [];
          for await (const ch of process.stdin) chunks.push(ch as Buffer);
          value = Buffer.concat(chunks).toString("utf8").trim();
        }
        if (!value) throw new Error("没有读到密钥内容");
        await c.json("PUT", path, { value });
        out(`${green("✓")} 已把 ${key} 保存到钥匙串（插件只能经宿主使用它，不会写入任何文件）`);
      }),
    );

  plugin
    .command("grant <plugin> <permission>")
    .description("授予权限，例如 harness plugin grant git-insight llm.invoke")
    .option("--scope <json>", "权限范围（JSON）；默认使用清单中声明的范围")
    .action(
      run(async (ref: string, permission: string, o: { scope?: string }) => {
        const c = await client();
        const id = await resolveId(c, ref);
        let scope: unknown;
        if (o.scope) {
          try {
            scope = JSON.parse(o.scope);
          } catch {
            throw new Error(`--scope 不是合法的 JSON：${o.scope}`);
          }
        }
        await c.json("POST", `/api/plugins/${enc(id)}/grants`, { permission, scope });
        out(`${green("✓")} 已授予 ${id} 权限 ${permission}（立即生效）`);
      }),
    );

  plugin
    .command("revoke <plugin> <permission>")
    .description("撤销权限（立即生效，插件下一次访问就会被拒绝）")
    .action(
      run(async (ref: string, permission: string) => {
        const c = await client();
        const id = await resolveId(c, ref);
        const r = await c.json<{ warning?: string }>("DELETE", `/api/plugins/${enc(id)}/grants/${enc(permission)}`);
        out(`${green("✓")} 已撤销 ${id} 的权限 ${permission}`);
        if (r.warning) out(`${yellow("!")} ${r.warning}`);
      }),
    );

  plugin
    .command("logs <plugin>")
    .description("查看插件日志（stderr、ctx.log 与宿主记录的故障）")
    .option("-n, --lines <n>", "显示最后多少行", "100")
    .option("-f, --follow", "持续输出新日志")
    .action(
      run(async (ref: string, o: { lines: string; follow?: boolean }) => {
        const c = await client();
        const id = await resolveId(c, ref);
        const fetchLines = async (n: number) => (await c.json<{ lines: string[] }>("GET", `/api/plugins/${enc(id)}/logs?lines=${n}`)).lines;
        let lines = await fetchLines(Number(o.lines) || 100);
        if (!lines.length && !o.follow) return out(dim("还没有日志"));
        for (const l of lines) out(colorLog(l));
        if (!o.follow) return;
        let last = lines.at(-1);
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          lines = await fetchLines(500);
          const idx = last ? lines.lastIndexOf(last) : -1;
          for (const l of lines.slice(idx + 1)) out(colorLog(l));
          last = lines.at(-1) ?? last;
        }
      }),
    );

  plugin
    .command("trace <plugin>")
    .description("查看宿主与插件之间最近的协议消息（调试用，已脱敏）")
    .option("-n, --last <n>", "显示最近多少条", "30")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (ref: string, o: { last: string; json?: boolean }) => {
        const c = await client();
        const id = await resolveId(c, ref);
        type Msg = { id?: unknown; method?: string; error?: { message: string } };
        const { entries } = await c.json<{ entries: Array<{ ts: string; direction: "in" | "out"; message: Msg }> }>("GET", `/api/plugins/${enc(id)}/trace`);
        const list = entries.slice(-(Number(o.last) || 30));
        if (o.json) return json(list);
        if (!list.length) return out(dim("没有记录（插件还没有运行过）"));
        for (const e of list) {
          const arrow = e.direction === "out" ? cyan("宿主 → 插件") : yellow("插件 → 宿主");
          const what = e.message.method ?? (e.message.error ? red(`错误 ${e.message.error.message}`) : "结果");
          out(`${dim(e.ts.slice(11, 23))} ${arrow} ${what}${e.message.id !== undefined ? dim(` #${String(e.message.id)}`) : ""}  ${dim(short(e.message, 140))}`);
        }
      }),
    );

  plugin
    .command("doctor")
    .description("检查所有插件的健康状况，并给出修复建议")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (o: { json?: boolean }) => {
        const c = await client();
        const r = await c.json<{ plugins: Summary[]; safeMode: boolean }>("GET", "/api/plugins");
        const st = await c.json<{ pid: number; version: string; subsystems?: { plugins?: { sandbox?: { mode: string; reason?: string } } } }>("GET", "/api/status");
        const sandbox = st.subsystems?.plugins?.sandbox ?? { mode: "degraded", reason: "未知" };
        const problems = r.plugins.filter((p) => BAD_STATES.includes(p.state) || (p.enabled && p.permissions.some((x) => x.required && !x.granted)));
        if (o.json) {
          json({ safeMode: r.safeMode, sandbox, plugins: r.plugins.length, problems });
          if (problems.length || sandbox.mode === "degraded") process.exitCode = 1;
          return;
        }
        out(`${green("✓")} harnessd ${st.version} 运行中（pid ${st.pid}）${r.safeMode ? yellow(" · 安全模式") : ""}`);
        if (sandbox.mode === "seatbelt") out(`${green("✓")} macOS Seatbelt 沙箱已启用：插件进程和它们请求运行的命令都在沙箱中`);
        else {
          const why = sandbox.mode === "off" ? "OS 沙箱已关闭" : "OS 沙箱不可用（降级模式）";
          out(`${yellow("!")} ${why}：${sandbox.reason ?? ""}`);
          out(`    ${dim("Node 插件仍受 Node 权限模型和宿主授权检查约束；Python 等插件无法运行。")}`);
          if (sandbox.mode === "off") out(`    ${dim("→ 恢复：去掉 HARNESS_SANDBOX=off，或在配置中把 sandbox 设为 \"auto\"，然后 harness daemon restart")}`);
          else process.exitCode = 1;
        }
        out(`${green("✓")} 已安装 ${r.plugins.length} 个插件，${r.plugins.filter((p) => p.state === "active").length} 个正在运行`);
        if (!problems.length) return out(`${green("✓")} 没有发现问题`);
        for (const p of problems) {
          out("");
          printSummaryLine(p);
          for (const x of p.permissions.filter((x) => x.required && !x.granted)) out(`    ${yellow("!")} 缺少必需权限「${x.label}」，相关功能会失败 → harness plugin grant ${p.id} ${x.id}`);
          if (p.state === "quarantined") out(`    ${dim("→")} 修复后运行 harness plugin enable ${p.id}`);
          if (p.state === "failed" || p.state === "invalid") out(`    ${dim("→")} 查看日志 harness plugin logs ${p.id}`);
        }
        process.exitCode = 1;
      }),
    );

  program
    .command("commands")
    .description("列出插件提供的斜杠命令")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (o: { json?: boolean }) => {
        const c = await client();
        const { commands } = await c.json<{ commands: Array<{ name: string; description: string; args?: string; pluginName: string }> }>("GET", "/api/commands");
        if (o.json) return json(commands);
        if (!commands.length) return out(dim("没有可用的命令（安装提供命令的插件后再试）"));
        for (const x of commands) out(`${bold(`/${x.name}`)}${x.args ? ` ${dim(x.args)}` : ""}  ${x.description}  ${dim(`· ${x.pluginName}`)}`);
      }),
    );

  program
    .command("run <command> [args...]")
    .description("运行插件提供的命令，例如 harness run /changelog v0.1.0")
    .option("-w, --workspace <dir>", "工作区目录（默认当前目录）")
    .option("--apply", "直接执行命令提出的动作（例如写入 CHANGELOG.md），不再询问")
    .option("--yes", "插件在运行中请求权限时自动允许（仅这次）")
    .option("--json", "以 JSON 输出")
    .action(
      run(async (command: string, args: string[], o: { workspace?: string; apply?: boolean; yes?: boolean; json?: boolean }) => {
        const c = await client();
        await runSlashCommand(c, [command, ...args.map(quoteArg)].join(" "), { workspace: o.workspace, apply: o.apply, json: o.json, approve: o.yes ? "yes" : "ask" });
      }),
    );
}

function absIfPath(source: string): string {
  const looksLikePath = source.startsWith(".") || source.startsWith("/") || source.startsWith("~") || source.endsWith(".harnessplugin");
  return looksLikePath ? resolve(source.replace(/^~(?=\/)/, process.env.HOME ?? "~")) : source;
}

function parseValue(raw: string): unknown {
  if (raw === "true" || raw === "false") return raw === "true";
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^[[{"]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      // keep as string
    }
  }
  return raw;
}

/** Splits a command line, honouring single and double quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3] ?? ""));
  return out;
}

function quoteArg(a: string): string {
  return /[\s"']/.test(a) ? `"${a.replace(/(["\\])/g, "\\$1")}"` : a;
}

function colorLog(l: string): string {
  if (/\b(error|fatal)\b/i.test(l)) return red(l);
  if (/\bwarn\b/i.test(l)) return yellow(l);
  if (l.includes("[harness]")) return cyan(l);
  return l;
}
