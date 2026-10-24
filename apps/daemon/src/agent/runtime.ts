import type { LanguageModelV4 } from "@ai-sdk/provider";
import { ErrorCode, HarnessError, newId, nowIso, redact, type ErrorInfo, type ToolRisk, type TurnEvent } from "@harness/shared";
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet } from "ai";
import type { HarnessConfig } from "../config.ts";
import type { SessionRepo, ToolCallRepo } from "../store/repos.ts";
import { ToolFailure, type ApprovalBroker, type HookOutcome, type HookRunner, type RegisteredTool, type ToolRegistry } from "./tools.ts";

const DEFAULT_SYSTEM = [
  "你是 Harness，一个运行在用户 Mac 本机上的 AI 助手。",
  "你能使用的所有工具都来自用户安装的插件；如果没有合适的工具，请如实说明当前没有这项能力，不要编造结果。",
  "工具返回 error 时，向用户简要说明原因，并尽量换一种办法完成任务。",
].join("\n");

/** Max bytes of a single tool result that may enter the model context (report 7.1). */
const MAX_TOOL_RESULT_BYTES = 1_000_000;

export interface RuntimeDeps {
  sessions: SessionRepo;
  toolCalls: ToolCallRepo;
  tools: ToolRegistry;
  hooks: HookRunner;
  approvals: ApprovalBroker;
  getConfig(): HarnessConfig;
  getModel(): Promise<LanguageModelV4>;
}

export interface TurnOptions {
  signal?: AbortSignal;
  emit(e: TurnEvent): void;
}

function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof HarnessError) return { code: err.code, name: err.toJSON().name, message: redact(err.message), data: err.data };
  const e = err as { message?: string; statusCode?: number; responseBody?: string };
  let message = redact(e?.message ?? String(err));
  if (e?.statusCode === 401) message = `模型提供方拒绝了 API Key（401）。请运行 harness auth set 重新设置。`;
  else if (e?.statusCode) message = `模型请求失败（HTTP ${e.statusCode}）：${message}`;
  return { code: ErrorCode.InternalError, name: "InternalError", message };
}

function truncateForModel(value: unknown): unknown {
  const s = JSON.stringify(value ?? null);
  if (Buffer.byteLength(s) <= MAX_TOOL_RESULT_BYTES) return value;
  return { truncated: true, note: "结果超过 1MB，已截断", preview: s.slice(0, 20_000) };
}

export class AgentRuntime {
  private readonly deps: RuntimeDeps;
  private readonly running = new Map<string, AbortController>();

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  cancel(sessionId: string): boolean {
    const c = this.running.get(sessionId);
    if (!c) return false;
    c.abort(new HarnessError(ErrorCode.Cancelled, "用户取消了本轮对话"));
    return true;
  }

  private needsApproval(risk: ToolRisk): boolean {
    return this.deps.getConfig().approvals[risk] === "ask";
  }

  private emitNotes(outcome: HookOutcome<unknown>, sessionId: string, turnId: string, emit: (e: TurnEvent) => void): void {
    for (const n of outcome.notes) emit({ type: "notice", sessionId, turnId, level: "info", message: n.note, pluginId: n.pluginId });
  }

  private buildTools(list: RegisteredTool[], sessionId: string, turnId: string, workspace: string | null, signal: AbortSignal, emit: (e: TurnEvent) => void): ToolSet {
    const set: ToolSet = {};
    for (const t of list) {
      set[t.name] = tool({
        description: t.description,
        inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (rawInput: unknown, opts: { toolCallId: string }) => {
          const callId = opts.toolCallId;
          const started = Date.now();
          const startedAt = nowIso();
          const finish = (ok: boolean, payload: { output?: unknown; error?: ErrorInfo; blockedBy?: string }, status: "ok" | "error" | "denied" | "blocked", input: unknown) => {
            const durationMs = Date.now() - started;
            this.deps.toolCalls.record({
              id: callId,
              sessionId,
              toolName: t.name,
              pluginId: t.pluginId,
              input,
              output: payload.output,
              error: payload.error?.message ?? null,
              status,
              startedAt,
              durationMs,
            });
            emit({ type: "tool.result", sessionId, turnId, callId, toolName: t.name, pluginId: t.pluginId, ok, durationMs, ...payload });
          };
          emit({ type: "tool.call", sessionId, turnId, callId, toolName: t.name, pluginId: t.pluginId, input: rawInput, risk: t.risk });

          // 1. tool.before hooks may rewrite arguments or block the call outright.
          const before = await this.deps.hooks.run("tool.before", { tool: t.name, pluginId: t.pluginId, arguments: rawInput }, { sessionId, turnId });
          this.emitNotes(before, sessionId, turnId, emit);
          if (before.blocked) {
            const error = { code: ErrorCode.PermissionDenied, name: "BlockedByPolicy", message: before.blocked.reason, data: { rule: before.blocked.rule } };
            finish(false, { error, blockedBy: before.blocked.pluginId }, "blocked", rawInput);
            return { error: "blocked_by_policy", reason: before.blocked.reason, rule: before.blocked.rule ?? null };
          }
          const input = (before.payload as { arguments: unknown }).arguments;

          // 2. Human approval for risky tools.
          if (this.needsApproval(t.risk)) {
            const approved = await this.deps.approvals.request({ sessionId, turnId, toolName: t.name, pluginId: t.pluginId, input, risk: t.risk }, signal);
            if (!approved) {
              const error = { code: ErrorCode.PermissionDenied, name: "PermissionDenied", message: "用户拒绝了这次工具调用" };
              finish(false, { error }, "denied", input);
              return { error: "denied_by_user", reason: "用户拒绝了这次工具调用" };
            }
          }

          // 3. Execute with the tool deadline.
          const ctrl = new AbortController();
          const onAbort = () => ctrl.abort(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          const timer = setTimeout(() => ctrl.abort(new HarnessError(ErrorCode.Timeout, `工具 ${t.name} 调用超时（${Math.round(t.timeoutMs / 1000)} 秒）`)), t.timeoutMs);
          try {
            const raw = await Promise.race([
              t.execute(input, { sessionId, turnId, callId, workspace, signal: ctrl.signal }),
              new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(ctrl.signal.reason), { once: true })),
            ]);
            // 4. tool.after hooks may redact the result before it enters the model context.
            const after = await this.deps.hooks.run("tool.after", { tool: t.name, pluginId: t.pluginId, arguments: input, result: raw }, { sessionId, turnId });
            this.emitNotes(after, sessionId, turnId, emit);
            if (after.blocked) {
              const error = { code: ErrorCode.PermissionDenied, name: "BlockedByPolicy", message: after.blocked.reason, data: { rule: after.blocked.rule } };
              finish(false, { error, blockedBy: after.blocked.pluginId }, "blocked", input);
              return { error: "blocked_by_policy", reason: after.blocked.reason, rule: after.blocked.rule ?? null };
            }
            const output = truncateForModel((after.payload as { result: unknown }).result);
            finish(true, { output }, "ok", input);
            return output;
          } catch (err) {
            if (err instanceof ToolFailure) {
              finish(false, { error: { code: ErrorCode.PluginError, name: err.payload.error, message: err.payload.message }, output: err.payload }, "error", input);
              return err.payload;
            }
            const error = toErrorInfo(err);
            finish(false, { error }, "error", input);
            const retryable = error.code === ErrorCode.Timeout || error.code === ErrorCode.NotActive;
            return { error: "tool_unavailable", reason: error.message, code: error.name ?? error.code, retryable };
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
          }
        },
      } as never);
    }
    return set;
  }

  /** Runs one user turn to completion. Never throws: failures surface as `turn.error`. */
  async runTurn(sessionId: string, userText: string, opts: TurnOptions): Promise<{ text: string; error?: ErrorInfo }> {
    const { sessions } = this.deps;
    const session = sessions.get(sessionId);
    const turnId = newId("turn");
    const emit = opts.emit;
    if (!session) {
      const error = { code: ErrorCode.InvalidParams, message: `会话不存在：${sessionId}` };
      emit({ type: "turn.error", sessionId, turnId, error });
      return { text: "", error };
    }
    if (this.running.has(sessionId)) {
      const error = { code: ErrorCode.InvalidRequest, message: "该会话正在处理上一条消息，请稍候或先取消。" };
      emit({ type: "turn.error", sessionId, turnId, error });
      return { text: "", error };
    }
    const ctrl = new AbortController();
    opts.signal?.addEventListener("abort", () => ctrl.abort(opts.signal?.reason), { once: true });
    this.running.set(sessionId, ctrl);
    const started = Date.now();
    emit({ type: "turn.start", sessionId, turnId });
    let finalText = "";
    try {
      const config = this.deps.getConfig();
      const prompt = await this.deps.hooks.run("prompt.before", { text: userText }, { sessionId, turnId });
      this.emitNotes(prompt, sessionId, turnId, emit);
      if (prompt.blocked) throw new HarnessError(ErrorCode.PermissionDenied, `消息被插件 ${prompt.blocked.pluginId} 阻止：${prompt.blocked.reason}`);
      const text = (prompt.payload as { text: string }).text;
      sessions.appendMessage(sessionId, "user", { role: "user", content: text } satisfies ModelMessage);
      if (session.title === "新会话") sessions.rename(sessionId, text.slice(0, 40) || "新会话");

      const history = sessions.messages(sessionId).map((m) => JSON.parse(m.content) as ModelMessage);
      const model = await this.deps.getModel();
      const tools = this.buildTools(this.deps.tools.list(), sessionId, turnId, session.workspace, ctrl.signal, emit);
      const system = [config.agent.system ?? DEFAULT_SYSTEM, session.workspace ? `当前工作区：${session.workspace}` : ""].filter(Boolean).join("\n");

      const result = streamText({
        model,
        system,
        messages: history,
        tools,
        stopWhen: stepCountIs(config.agent.maxSteps),
        abortSignal: ctrl.signal,
        timeout: { totalMs: config.agent.totalTimeoutMs },
        maxRetries: 1,
        prepareStep: async ({ messages }: { messages: ModelMessage[] }) => {
          const out = await this.deps.hooks.run("model.request.before", { system, messages }, { sessionId, turnId });
          this.emitNotes(out, sessionId, turnId, emit);
          if (out.blocked) throw new HarnessError(ErrorCode.PermissionDenied, `模型请求被插件 ${out.blocked.pluginId} 阻止：${out.blocked.reason}`, { blockedBy: out.blocked.pluginId });
          const p = out.payload as { system: string; messages: ModelMessage[] };
          return { system: p.system, messages: p.messages };
        },
      } as never);

      let stepText = "";
      let assistantParts: unknown[] = [];
      let toolResults: unknown[] = [];
      let streamError: unknown = null;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      const flush = () => {
        if (stepText) assistantParts.unshift({ type: "text", text: stepText });
        if (assistantParts.length) sessions.appendMessage(sessionId, "assistant", { role: "assistant", content: assistantParts });
        if (toolResults.length) sessions.appendMessage(sessionId, "tool", { role: "tool", content: toolResults });
        stepText = "";
        assistantParts = [];
        toolResults = [];
      };
      for await (const part of (result as { fullStream: AsyncIterable<Record<string, unknown>> }).fullStream) {
        switch (part.type) {
          case "text-delta": {
            const t = String(part.text ?? "");
            stepText += t;
            finalText += t;
            emit({ type: "text.delta", sessionId, turnId, text: t });
            break;
          }
          case "tool-call":
            assistantParts.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
            break;
          case "tool-result":
            toolResults.push({ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: { type: "json", value: part.output ?? null } });
            break;
          case "tool-error":
            toolResults.push({ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: { type: "error-text", value: redact(String((part.error as Error)?.message ?? part.error)) } });
            break;
          case "finish-step":
            flush();
            break;
          case "finish": {
            const u = part.totalUsage as { inputTokens?: number; outputTokens?: number } | undefined;
            usage = u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens } : undefined;
            break;
          }
          case "error":
            streamError = part.error;
            break;
          case "abort":
            streamError = ctrl.signal.reason ?? new HarnessError(ErrorCode.Cancelled, "已取消");
            break;
        }
      }
      flush();
      if (streamError) throw streamError;
      emit({ type: "turn.end", sessionId, turnId, text: finalText, usage, durationMs: Date.now() - started });
      return { text: finalText };
    } catch (err) {
      const error = toErrorInfo(ctrl.signal.aborted && ctrl.signal.reason ? ctrl.signal.reason : err);
      emit({ type: "turn.error", sessionId, turnId, error });
      return { text: finalText, error };
    } finally {
      this.running.delete(sessionId);
    }
  }
}
