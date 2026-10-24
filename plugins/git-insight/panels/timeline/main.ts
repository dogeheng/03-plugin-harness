import { connectHost, type PanelHost } from "@harness/plugin-sdk/panel";

interface Commit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}
interface FileStat {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // never innerHTML: commit subjects are untrusted
  return e;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "今天";
  if (same(d, y)) return "昨天";
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

function message(text: string, cls = "note") {
  const list = $("list");
  list.replaceChildren(el("p", cls, text));
}

async function toggleFiles(host: PanelHost, row: HTMLElement, c: Commit) {
  const open = row.getAttribute("aria-expanded") === "true";
  row.querySelector(".files")?.remove();
  row.setAttribute("aria-expanded", String(!open));
  if (open) return;
  const box = el("div", "files", "读取变更…");
  row.append(box);
  const r = await host.callTool<{ files: FileStat[]; totals: { files: number; added: number; deleted: number }; message?: string }>("git_diff_summary", { from: `${c.hash}^`, to: c.hash }).catch((e: Error) => ({ ok: false, output: { message: e.message } as never }));
  box.replaceChildren();
  if (!r.ok) {
    box.append(el("div", "", /unknown revision|bad revision|ambiguous/i.test(r.output?.message ?? "") ? "这是仓库的第一个提交" : `无法读取变更：${r.output?.message ?? "未知错误"}`));
    return;
  }
  const { files, totals } = r.output;
  for (const f of files) {
    const line = el("div", "file");
    line.append(el("span", "path", f.path));
    const n = el("span");
    if (f.binary) n.append(el("span", "", "二进制"));
    else n.append(el("span", "add", `+${f.added}`), document.createTextNode(" "), el("span", "del", `−${f.deleted}`));
    line.append(n);
    box.append(line);
  }
  box.append(el("div", "file", `共 ${totals.files} 个文件，+${totals.added} −${totals.deleted}`));
}

async function load(host: PanelHost) {
  if (!host.context.workspace) {
    $("branch").textContent = "没有工作区";
    $("summary").textContent = "";
    return message("当前会话没有设置工作区目录。在会话设置中选择一个 Git 仓库后再打开这个面板。");
  }
  $("summary").textContent = "正在读取仓库…";
  const [status, log] = await Promise.all([
    host.callTool<{ branch: string | null; ahead?: number; behind?: number; message?: string }>("git_status"),
    host.callTool<{ commits: Commit[]; count: number; message?: string }>("git_log", { limit: 50 }),
  ]).catch((e: Error) => [{ ok: false, output: { message: e.message } }, { ok: false, output: { message: e.message } }] as const);
  if (!log.ok) {
    $("branch").textContent = "无法读取";
    $("summary").textContent = "";
    return message(log.output?.message ?? "读取提交失败", "error");
  }
  const st = status.ok ? status.output : null;
  $("branch").textContent = st?.branch ? `⎇ ${st.branch}` : "（分离 HEAD）";
  const commits = (log.output as { commits: Commit[] }).commits;
  $("summary").textContent = `最近 ${commits.length} 个提交${st?.ahead ? ` · 领先 ${st.ahead}` : ""}${st?.behind ? ` · 落后 ${st.behind}` : ""}`;
  if (!commits.length) return message("这个仓库还没有提交。");
  const list = $("list");
  list.replaceChildren();
  let lastDay = "";
  for (const c of commits) {
    const day = dayLabel(c.date);
    if (day !== lastDay) {
      list.append(el("div", "day", day));
      lastDay = day;
    }
    const row = el("div", "commit");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", "false");
    row.dataset.hash = c.hash;
    row.append(el("span", "subject", c.subject));
    const meta = el("span", "meta");
    meta.append(el("span", "hash", c.short), el("span", "", c.author), el("span", "", new Date(c.date).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })));
    row.append(meta);
    const go = (ev: Event) => {
      if ((ev.target as HTMLElement).closest(".files")) return;
      void toggleFiles(host, row, c);
    };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        go(ev);
      }
    });
    list.append(row);
  }
}

async function main() {
  let host: PanelHost;
  try {
    host = await connectHost();
  } catch (e) {
    return message(`无法连接 Harness：${(e as Error).message}`, "error");
  }
  $("refresh").addEventListener("click", () => void load(host));
  host.onContextChange(() => void load(host));
  await load(host);
}

void main();
