import { createInterface } from "node:readline/promises";
import { styleText } from "node:util";
import type { HostEvent } from "@harness/shared";
import type { DaemonClient } from "./client.ts";
import { answerConfirm, answerPermission, runSlashCommand } from "./plugins.ts";
import { printError } from "./ui.ts";

const dim = (s: string) => styleText("dim", s);
const red = (s: string) => styleText("red", s);
const green = (s: string) => styleText("green", s);
const yellow = (s: string) => styleText("yellow", s);
const cyan = (s: string) => styleText("cyan", s);

function short(v: unknown, max = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface RenderOptions {
  /** How to answer approval requests when stdin is not interactive. */
  approve?: "ask" | "yes" | "no";
  json?: boolean;
  out?: NodeJS.WritableStream;
}

async function askApproval(e: Extract<HostEvent, { type: "approval.request" }>, mode: "ask" | "yes" | "no"): Promise<boolean> {
  if (mode !== "ask") return mode === "yes";
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const who = e.pluginId ? `插件 ${e.pluginId} 的工具` : "工具";
  const answer = await rl.question(yellow(`\n? 允许${who} ${e.toolName} 执行吗？（风险：${e.risk}）参数：${short(e.input)} [y/N] `));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Sends one message and renders the streamed turn. Returns the final assistant text. */
export async function sendAndRender(client: DaemonClient, sessionId: string, text: string, opts: RenderOptions = {}): Promise<{ text: string; ok: boolean }> {
  const out = opts.out ?? process.stdout;
  let final = "";
  let ok = true;
  let midLine = false;
  for await (const e of client.stream<HostEvent>(`/api/sessions/${sessionId}/messages`, { text })) {
    if (opts.json) {
      out.write(`${JSON.stringify(e)}\n`);
    }
    switch (e.type) {
      case "text.delta":
        final += e.text;
        if (!opts.json) out.write(e.text);
        midLine = !e.text.endsWith("\n");
        break;
      case "tool.call":
        if (!opts.json) {
          if (midLine) out.write("\n");
          out.write(dim(`  ⚙ ${e.toolName}${e.pluginId ? ` · ${e.pluginId}` : ""} ${short(e.input, 100)}\n`));
          midLine = false;
        }
        break;
      case "tool.result":
        if (!opts.json) {
          const head = e.ok ? green("  ✓") : red("  ✗");
          const detail = e.ok ? dim(`${e.durationMs}ms`) : red(e.error?.message ?? "失败");
          out.write(`${head} ${dim(e.toolName)} ${detail}${e.blockedBy ? yellow(` （被 ${e.blockedBy} 拦截）`) : ""}\n`);
        }
        break;
      case "approval.request": {
        const approved = await askApproval(e, opts.approve ?? "ask");
        await client.json("POST", `/api/approvals/${e.approvalId}`, { approved });
        if (!opts.json) out.write(dim(`  ${approved ? "已允许" : "已拒绝"}\n`));
        break;
      }
      case "permission.request": {
        const msg = await answerPermission(client, e, opts.approve ?? "ask");
        if (!opts.json) out.write(dim(`  ${msg}\n`));
        break;
      }
      case "confirm.request": {
        const msg = await answerConfirm(client, e, opts.approve ?? "ask");
        if (!opts.json) out.write(dim(`  ${msg}\n`));
        break;
      }
      case "notice":
        if (!opts.json) out.write(`${e.level === "error" ? red("!") : yellow("!")} ${e.message}\n`);
        break;
      case "turn.error":
        ok = false;
        if (!opts.json) {
          if (midLine) out.write("\n");
          out.write(`${red("✗ 出错了：")}${e.error.message}\n`);
        }
        break;
      case "turn.end":
        if (!opts.json) {
          if (midLine || final) out.write("\n");
          const u = e.usage;
          out.write(dim(`  ${(e.durationMs / 1000).toFixed(1)}s${u?.inputTokens != null ? ` · ${u.inputTokens}→${u.outputTokens} tokens` : ""}\n`));
        }
        break;
    }
  }
  return { text: final, ok };
}

export async function repl(client: DaemonClient, sessionId: string, opts: RenderOptions = {}): Promise<void> {
  process.stdout.write(cyan("Harness 对话（/help 查看命令，/exit 退出）\n"));
  let current = sessionId;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const line = (await rl.question(cyan("› "))).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/new") {
        const r = await client.json<{ session: { id: string } }>("POST", "/api/sessions", {});
        current = r.session.id;
        process.stdout.write(dim(`新会话 ${current}\n`));
        continue;
      }
      if (line === "/help") {
        const { commands } = await client.json<{ commands: Array<{ name: string; description: string; args?: string; pluginName: string }> }>("GET", "/api/commands");
        process.stdout.write(`${dim("内置：")}/new 新会话 · /exit 退出 · /help 帮助\n`);
        for (const x of commands) process.stdout.write(`/${x.name}${x.args ? ` ${dim(x.args)}` : ""}  ${x.description}  ${dim(`· ${x.pluginName}`)}\n`);
        if (!commands.length) process.stdout.write(dim("（还没有插件提供命令）\n"));
        continue;
      }
      rl.pause();
      try {
        if (line.startsWith("/")) await runSlashCommand(client, line, { sessionId: current, approve: opts.approve });
        else await sendAndRender(client, current, line, opts);
      } catch (err) {
        printError(err);
      }
      rl.resume();
    }
  } finally {
    rl.close();
  }
}
