import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { styleText } from "node:util";
import { password, isCancel } from "@clack/prompts";
import { resolvePaths, sleep } from "@harness/shared";
import { Command } from "commander";
import { sendAndRender, repl } from "./chat.ts";
import { ApiError, DaemonClient, ensureDaemon, healthy, pidAlive, readDaemonInfo, startDaemonProcess } from "./client.ts";
import { registerPluginCommands } from "./plugins.ts";

const VERSION = "0.1.0";
const dim = (s: string) => styleText("dim", s);
const green = (s: string) => styleText("green", s);
const red = (s: string) => styleText("red", s);

function fail(err: unknown): never {
  const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
  process.stderr.write(`${red("✗")} ${msg}\n`);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function daemonStart(): Promise<void> {
  const paths = resolvePaths();
  if (await healthy(readDaemonInfo(paths))) {
    process.stdout.write(`harnessd 已在运行（pid ${readDaemonInfo(paths)?.pid}）\n`);
    return;
  }
  const c = await ensureDaemon().catch(fail);
  process.stdout.write(`${green("✓")} harnessd 已启动（pid ${c.info.pid}，端口 ${c.info.port}）\n`);
}

async function daemonStop(): Promise<void> {
  const paths = resolvePaths();
  const info = readDaemonInfo(paths);
  if (!info || !pidAlive(info.pid)) {
    process.stdout.write("harnessd 未在运行\n");
    return;
  }
  try {
    await new DaemonClient(info).json("POST", "/api/daemon/shutdown");
  } catch {
    process.kill(info.pid, "SIGTERM");
  }
  for (let i = 0; i < 50 && pidAlive(info.pid); i++) await sleep(100);
  process.stdout.write(pidAlive(info.pid) ? red("harnessd 未能在 5 秒内退出\n") : `${green("✓")} harnessd 已停止\n`);
}

async function daemonStatus(o: { json?: boolean }): Promise<void> {
  const info = readDaemonInfo(resolvePaths());
  if (!(await healthy(info))) {
    process.stdout.write(o.json ? `${JSON.stringify({ running: false })}\n` : "harnessd 未在运行\n");
    return;
  }
  const s = await new DaemonClient(info as NonNullable<typeof info>).json("GET", "/api/status");
  if (o.json) process.stdout.write(`${JSON.stringify({ running: true, ...s }, null, 2)}\n`);
  else {
    const st = s as { pid: number; port: number; uptimeSec: number; model: { provider: string; id: string }; tools: unknown[]; secretsBackend: string; subsystems?: { plugins?: { sandbox?: { mode: string } } } };
    const mode = st.subsystems?.plugins?.sandbox?.mode;
    const sandbox = mode === "seatbelt" ? "Seatbelt" : mode === "off" ? "已关闭" : mode ? "降级模式" : "未加载";
    process.stdout.write(
      `${green("●")} harnessd 运行中  pid ${st.pid} · 端口 ${st.port} · 已运行 ${st.uptimeSec}s\n  模型 ${st.model.provider}/${st.model.id} · 工具 ${st.tools.length} 个 · 密钥后端 ${st.secretsBackend} · 沙箱 ${sandbox}\n`,
    );
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("harness").description("本地、可插件扩展的 AI Agent Harness").version(VERSION);

  // ---- daemon --------------------------------------------------------------
  const daemon = program.command("daemon").description("管理后台进程 harnessd");
  daemon.command("start").description("在后台启动 harnessd").action(daemonStart);
  daemon.command("stop").description("停止 harnessd").action(daemonStop);
  daemon
    .command("restart")
    .description("重启 harnessd")
    .action(async () => {
      await daemonStop();
      await daemonStart();
    });
  daemon.command("status").description("显示 harnessd 状态").option("--json", "以 JSON 输出").action(daemonStatus);
  daemon
    .command("logs")
    .description("显示 harnessd 日志的最后若干行")
    .option("-n, --lines <n>", "行数", "60")
    .action((o: { lines: string }) => {
      const paths = resolvePaths();
      try {
        const lines = readFileSync(`${paths.logsDir}/harnessd.log`, "utf8").trim().split("\n");
        process.stdout.write(`${lines.slice(-Number(o.lines)).join("\n")}\n`);
      } catch {
        process.stdout.write("暂无日志\n");
      }
    });

  program
    .command("serve")
    .description("在前台运行 harnessd（调试用）")
    .action(async () => {
      await import("../../daemon/src/main.ts");
    });

  program
    .command("status")
    .description("显示 harnessd 状态（同 daemon status）")
    .option("--json", "以 JSON 输出")
    .action(daemonStatus);

  // ---- web UI --------------------------------------------------------------
  program
    .command("open")
    .description("用浏览器打开 Harness 管理界面（一次性登录链接）")
    .option("--print", "只打印链接，不打开浏览器")
    .action(async (o: { print?: boolean }) => {
      const c = await ensureDaemon().catch(fail);
      const { url } = await c.json<{ url: string }>("POST", "/api/auth/login-link");
      if (o.print) process.stdout.write(`${url}\n`);
      else {
        execFile("open", [url]);
        process.stdout.write(`${green("✓")} 已在浏览器中打开 Harness（链接 2 分钟内有效、只能使用一次）\n`);
      }
    });

  // ---- chat ----------------------------------------------------------------
  program
    .command("chat")
    .description("与 Agent 对话；带参数时发送单条消息，不带参数进入交互模式")
    .argument("[message...]", "要发送的消息")
    .option("-s, --session <id>", "继续指定会话")
    .option("-w, --workspace <dir>", "会话的工作区目录（默认当前目录）")
    .option("--json", "输出原始事件流（NDJSON）")
    .option("-y, --yes", "自动允许所有需要审批的工具调用")
    .option("--no-approve", "自动拒绝所有需要审批的工具调用")
    .action(async (words: string[], o: { session?: string; workspace?: string; json?: boolean; yes?: boolean; approve?: boolean }) => {
      const c = await ensureDaemon().catch(fail);
      let sessionId = o.session;
      if (!sessionId) {
        const r = await c.json<{ session: { id: string } }>("POST", "/api/sessions", { workspace: o.workspace ?? process.cwd() }).catch(fail);
        sessionId = r.session.id;
      }
      const approve = o.yes ? "yes" : o.approve === false ? "no" : "ask";
      if (words.length) {
        const r = await sendAndRender(c, sessionId, words.join(" "), { json: o.json, approve }).catch(fail);
        if (!o.json) process.stdout.write(dim(`  会话 ${sessionId}\n`));
        process.exit(r.ok ? 0 : 2);
      }
      await repl(c, sessionId, { approve });
    });

  program
    .command("sessions")
    .description("列出最近的会话")
    .action(async () => {
      const c = await ensureDaemon().catch(fail);
      const r = await c.json<{ sessions: Array<{ id: string; title: string; updated_at: string }> }>("GET", "/api/sessions");
      for (const s of r.sessions) process.stdout.write(`${s.id}  ${dim(s.updated_at.slice(0, 19).replace("T", " "))}  ${s.title}\n`);
      if (!r.sessions.length) process.stdout.write("还没有会话\n");
    });

  // ---- auth ----------------------------------------------------------------
  const auth = program.command("auth").description("管理模型提供方的 API Key（存放在 macOS 钥匙串）");
  auth
    .command("set")
    .description("设置提供方的 API Key")
    .argument("<provider>", "提供方 id，例如 openrouter")
    .option("--stdin", "从标准输入读取 Key（不会出现在命令行参数和 shell 历史中）")
    .action(async (provider: string, o: { stdin?: boolean }) => {
      let key = "";
      if (o.stdin || !process.stdin.isTTY) key = await readStdin();
      else {
        const v = await password({ message: `请输入 ${provider} 的 API Key（输入内容不会显示）` });
        if (isCancel(v)) process.exit(130);
        key = String(v).trim();
      }
      if (!key) fail("没有读到 API Key");
      const c = await ensureDaemon().catch(fail);
      await c.json("PUT", `/api/providers/${encodeURIComponent(provider)}/key`, { apiKey: key }).catch(fail);
      key = "";
      process.stdout.write(`${green("✓")} 已把 ${provider} 的 API Key 保存到 macOS 钥匙串\n`);
    });
  auth
    .command("status")
    .description("查看各提供方是否已配置 Key")
    .action(async () => {
      const c = await ensureDaemon().catch(fail);
      const r = await c.json<{ providers: Array<{ id: string; label: string; configured: boolean; requiresKey: boolean }>; current: { provider: string; id: string } }>("GET", "/api/providers");
      for (const p of r.providers) {
        const mark = p.configured ? green("●") : dim("○");
        process.stdout.write(`${mark} ${p.id.padEnd(18)} ${p.label}${p.requiresKey ? "" : dim("（无需 Key）")}${r.current.provider === p.id ? green("  ← 当前") : ""}\n`);
      }
    });
  auth
    .command("remove")
    .description("从钥匙串删除提供方的 API Key")
    .argument("<provider>")
    .action(async (provider: string) => {
      const c = await ensureDaemon().catch(fail);
      await c.json("DELETE", `/api/providers/${encodeURIComponent(provider)}/key`).catch(fail);
      process.stdout.write(`${green("✓")} 已删除 ${provider} 的 API Key\n`);
    });

  // ---- model ---------------------------------------------------------------
  const model = program.command("model").description("查看或切换模型");
  model
    .command("show")
    .description("显示当前模型")
    .action(async () => {
      const c = await ensureDaemon().catch(fail);
      const r = await c.json<{ current: { provider: string; id: string } }>("GET", "/api/providers");
      process.stdout.write(`${r.current.provider} / ${r.current.id}\n`);
    });
  model
    .command("set")
    .description("切换模型，例如：harness model set openrouter anthropic/claude-haiku-5.5")
    .argument("<provider>")
    .argument("<modelId>")
    .option("--base-url <url>", "OpenAI 兼容接口的地址")
    .action(async (provider: string, id: string, o: { baseUrl?: string }) => {
      const c = await ensureDaemon().catch(fail);
      await c.json("PUT", "/api/config/model", { provider, id, baseURL: o.baseUrl }).catch(fail);
      process.stdout.write(`${green("✓")} 当前模型：${provider} / ${id}\n`);
    });

  // ---- approvals -----------------------------------------------------------
  program
    .command("approvals")
    .description("设置某类风险的工具是否需要审批，例如：harness approvals write ask")
    .argument("<risk>", "read | write | exec | network")
    .argument("<mode>", "auto | ask")
    .action(async (risk: string, mode: string) => {
      const c = await ensureDaemon().catch(fail);
      await c.json("PATCH", "/api/config", { approvals: { [risk]: mode } }).catch(fail);
      process.stdout.write(`${green("✓")} ${risk} 类工具：${mode === "ask" ? "每次询问" : "自动执行"}\n`);
    });

  registerPluginCommands(program, { fail });
  return program;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain || process.env.HARNESS_CLI_MAIN === "1") {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err) => fail(err));
}

export { startDaemonProcess };
