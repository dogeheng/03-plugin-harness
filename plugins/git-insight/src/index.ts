import { type CallContext, command, definePlugin, type PluginContext, ToolError, tool, z } from "@harness/plugin-sdk";

const US = "\x1f";
const RS = "\x1e";
const REF = /^[A-Za-z0-9._/@^~{}-]{1,100}$/;
const SAFE_TEXT = /^[\p{L}\p{N}\s:.,@+_-]{1,60}$/u;

function workspaceOf(ctx: CallContext): string {
  const ws = ctx.session?.workspace ?? ctx.workspace.root;
  if (!ws) throw new ToolError("no_workspace", "当前会话没有工作区。请在项目目录中运行 harness chat，或用 --workspace 指定目录");
  return ws;
}

function checkRef(name: string, ref: string): string {
  if (!REF.test(ref) || ref.startsWith("-")) throw new ToolError("invalid_revision", `${name}「${ref}」不是合法的 Git 版本号`);
  return ref;
}

export async function git(ctx: CallContext | PluginContext, args: string[], cwd: string): Promise<string> {
  let r: Awaited<ReturnType<CallContext["host"]["process"]["exec"]>>;
  try {
    r = await ctx.host.process.exec("git", args, { cwd, timeoutMs: 10_000 });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/ENOENT/.test(msg)) throw new ToolError("git_not_installed", "这台 Mac 上没有找到 git。请运行 xcode-select --install 安装命令行工具");
    throw e;
  }
  if (r.exitCode !== 0) {
    const err = r.stderr.trim();
    if (/not a git repository/i.test(err)) throw new ToolError("not_a_repository", `${cwd} 不是 Git 仓库`, { path: cwd });
    if (/does not have any commits yet|bad default revision/i.test(err)) throw new ToolError("empty_repository", "这个仓库还没有任何提交");
    if (/unknown revision|bad revision|ambiguous argument|invalid object/i.test(err)) throw new ToolError("unknown_revision", `找不到指定的版本：${err.split("\n")[0]}`);
    throw new ToolError("git_failed", `git ${args[0]} 失败：${err.slice(0, 300)}`);
  }
  return r.stdout;
}

const STATUS: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type-changed", U: "unmerged" };

export function parseStatus(out: string) {
  const res = {
    branch: null as string | null,
    upstream: null as string | null,
    ahead: 0,
    behind: 0,
    staged: [] as Array<{ path: string; status: string; from?: string }>,
    unstaged: [] as Array<{ path: string; status: string }>,
    untracked: [] as string[],
    conflicts: [] as string[],
  };
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) res.branch = line.slice(14) === "(detached)" ? null : line.slice(14);
    else if (line.startsWith("# branch.upstream ")) res.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        res.ahead = Number(m[1]);
        res.behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const rest = parts.slice(line.startsWith("1 ") ? 8 : 9).join(" ");
      const [path, from] = rest.split("\t") as [string, string | undefined];
      if (xy[0] !== ".") res.staged.push({ path, status: STATUS[xy[0] as string] ?? xy[0] as string, ...(from ? { from } : {}) });
      if (xy[1] !== ".") res.unstaged.push({ path, status: STATUS[xy[1] as string] ?? xy[1] as string });
    } else if (line.startsWith("u ")) res.conflicts.push(line.split(" ").slice(10).join(" "));
    else if (line.startsWith("? ")) res.untracked.push(line.slice(2));
  }
  const cap = <T>(a: T[]) => a.slice(0, 200);
  return {
    ...res,
    clean: !res.staged.length && !res.unstaged.length && !res.untracked.length && !res.conflicts.length,
    staged: cap(res.staged),
    unstaged: cap(res.unstaged),
    untracked: cap(res.untracked),
    totals: { staged: res.staged.length, unstaged: res.unstaged.length, untracked: res.untracked.length, conflicts: res.conflicts.length },
  };
}

export function parseLog(out: string) {
  return out
    .split(RS)
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, date, subject] = r.split(US);
      return { hash, short, author, date, subject };
    });
}

export function parseNumstat(out: string) {
  const files = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split("\t");
      const binary = a === "-" && d === "-";
      return { path: p.join("\t"), added: binary ? 0 : Number(a), deleted: binary ? 0 : Number(d), binary };
    });
  return { files: files.slice(0, 300), totals: { files: files.length, added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0) } };
}

// ---- changelog ---------------------------------------------------------------

const SECTIONS: Record<string, { zh: string; en: string; order: number }> = {
  breaking: { zh: "破坏性变更", en: "Breaking changes", order: 0 },
  feat: { zh: "新功能", en: "Features", order: 1 },
  fix: { zh: "问题修复", en: "Bug fixes", order: 2 },
  perf: { zh: "性能优化", en: "Performance", order: 3 },
  refactor: { zh: "重构", en: "Refactoring", order: 4 },
  docs: { zh: "文档", en: "Documentation", order: 5 },
  other: { zh: "其他改动", en: "Other changes", order: 6 },
};

const CONVENTIONAL = new Set(["feat", "fix", "perf", "refactor", "docs", "chore", "build", "ci", "test", "style", "revert"]);

export function buildChangelog(commits: Array<{ short?: string; subject?: string }>, opts: { lang: "zh-CN" | "en"; title: string }): string {
  const groups = new Map<string, string[]>();
  for (const c of commits) {
    const subject = (c.subject ?? "").trim();
    if (!subject || /^Merge (branch|pull request)/.test(subject)) continue;
    const raw = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
    // Only Conventional Commit types count; "M0: ..." or "WIP: ..." keep their full subject.
    const m = raw && CONVENTIONAL.has(raw[1]?.toLowerCase() ?? "") ? raw : null;
    const type = m ? (m[3] ? "breaking" : (m[1]?.toLowerCase() ?? "other")) : "other";
    const key = SECTIONS[type] ? type : "other";
    const text = m ? `${m[2] ? `**${m[2]}:** ` : ""}${m[4]}` : subject;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(`- ${text} (${c.short})`);
  }
  const zh = opts.lang === "zh-CN";
  const lines = [`## ${opts.title}`, ""];
  if (!groups.size) lines.push(zh ? "_没有需要记录的提交。_" : "_No notable commits._");
  for (const [key, items] of [...groups.entries()].sort((a, b) => (SECTIONS[a[0]]?.order ?? 9) - (SECTIONS[b[0]]?.order ?? 9))) {
    lines.push(`### ${zh ? SECTIONS[key]?.zh : SECTIONS[key]?.en}`, "", ...items, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      out[k] = v ?? (args[i + 1] && !args[i + 1]?.startsWith("--") ? (args[++i] as string) : "true");
    }
  }
  return out;
}

const LOG_FORMAT = `--pretty=format:%H${US}%h${US}%an${US}%ad${US}%s${RS}`;

export default definePlugin({
  async activate(ctx) {
    try {
      const v = await ctx.host.process.exec("git", ["version"], { timeoutMs: 5_000 });
      ctx.log.info(`git-insight 已激活：${v.stdout.trim()}`);
    } catch (e) {
      ctx.log.warn(`没有检测到可用的 git：${(e as Error).message}`);
    }
  },

  tools: {
    git_status: tool({
      input: z.object({}).strict(),
      async execute(_input, ctx) {
        const cwd = workspaceOf(ctx);
        return parseStatus(await git(ctx, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], cwd));
      },
    }),

    git_log: tool({
      input: z
        .object({
          limit: z.number().int().min(1).max(500).default(20),
          since: z.string().regex(SAFE_TEXT, "只能包含字母、数字、空格和 :.,@+_-").optional(),
          author: z.string().regex(SAFE_TEXT, "只能包含字母、数字、空格和 :.,@+_-").optional(),
          path: z
            .string()
            .min(1)
            .refine((p) => !p.startsWith("-"), "路径不能以 - 开头")
            .optional(),
        })
        .strict(),
      async execute(input, ctx) {
        const cwd = workspaceOf(ctx);
        const max = Number(ctx.config.maxCommits ?? 200);
        const limit = Math.min(input.limit, max);
        const args = ["log", `-n${limit}`, LOG_FORMAT, "--date=iso-strict", "--no-color"];
        if (input.since) args.push(`--since=${input.since}`);
        if (input.author) args.push(`--author=${input.author}`);
        args.push("--");
        if (input.path) args.push(input.path);
        const commits = parseLog(await git(ctx, args, cwd));
        return { commits, count: commits.length, limitedTo: limit, ...(input.limit > max ? { note: `已按设置 maxCommits=${max} 截断` } : {}) };
      },
    }),

    git_diff_summary: tool({
      input: z.object({ from: z.string().min(1), to: z.string().min(1).default("HEAD") }).strict(),
      async execute(input, ctx) {
        const cwd = workspaceOf(ctx);
        const range = `${checkRef("from", input.from)}..${checkRef("to", input.to)}`;
        const stat = parseNumstat(await git(ctx, ["diff", "--numstat", "--no-color", "--no-ext-diff", "--no-renames", range, "--"], cwd));
        return { from: input.from, to: input.to, ...stat };
      },
    }),
  },

  commands: {
    changelog: command({
      async run(args, ctx) {
        const cwd = workspaceOf(ctx);
        const opts = parseArgs(args);
        const lang = ctx.config.changelogLang === "en" ? "en" : "zh-CN";
        const to = checkRef("--to", opts.to ?? "HEAD");
        let base = opts.since ? checkRef("--since", opts.since) : null;
        if (!base) {
          try {
            base = (await git(ctx, ["describe", "--tags", "--abbrev=0", to], cwd)).trim() || null;
          } catch (e) {
            if (!(e instanceof ToolError) || e.code === "not_a_repository") throw e;
            base = null; // no tags yet: use the whole (capped) history
          }
        }
        const max = Number(ctx.config.maxCommits ?? 200);
        const range = base ? [`${base}..${to}`] : [`-n${max}`, to];
        const commits = parseLog(await git(ctx, ["log", ...range, LOG_FORMAT, "--date=short", "--no-color", "--"], cwd));
        const today = new Date().toISOString().slice(0, 10);
        const title = lang === "zh-CN" ? `${today}${base ? `（${base} 之后的 ${commits.length} 个提交）` : `（最近 ${commits.length} 个提交）`}` : `${today}${base ? ` (${commits.length} commits since ${base})` : ` (last ${commits.length} commits)`}`;
        let markdown = buildChangelog(commits, { lang, title });
        let polished = false;
        if (ctx.config.polish !== false && ctx.hasPermission("llm.invoke") && commits.length) {
          try {
            const r = await ctx.host.llm.generate({
              system:
                lang === "zh-CN"
                  ? "你是发布说明编辑。把给定的变更日志草稿改写成简洁、面向用户的中文发布说明。保留 Markdown 结构、二级/三级标题和每条末尾的提交短哈希，不要编造草稿中没有的内容。只输出 Markdown。"
                  : "You edit release notes. Rewrite the draft changelog into concise, user-facing English release notes. Keep the Markdown structure, headings and the short commit hash at the end of each item. Never invent changes. Output Markdown only.",
              prompt: markdown,
              maxOutputTokens: 1500,
            });
            if (r.text.trim().startsWith("#")) {
              markdown = `${r.text.trim()}\n`;
              polished = true;
            }
          } catch (e) {
            ctx.log.warn(`润色失败，使用模板结果：${(e as Error).message}`);
          }
        }
        const footer = polished ? "" : ctx.hasPermission("llm.invoke") ? "" : lang === "zh-CN" ? "\n> 提示：授予 Git Insight“调用模型”权限后，可以自动润色成面向用户的说明。\n" : "";
        return {
          markdown: markdown + footer,
          actions: [{ id: "write-changelog", label: lang === "zh-CN" ? "写入 CHANGELOG.md" : "Write to CHANGELOG.md", kind: "write-file", path: "CHANGELOG.md", content: markdown, mode: "prepend" }],
        };
      },
    }),
  },
});
