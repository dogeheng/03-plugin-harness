import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4StreamPart } from "@ai-sdk/provider";

/**
 * A deterministic, offline language model used by automated tests and demos.
 *
 * Behaviour is driven by a script: a list of rules matched against the latest
 * user message. A rule yields one "plan" of steps; each step either emits tool
 * calls or text. Tool results from previous steps can be interpolated into
 * text with `{{result}}` (the JSON of the last tool result).
 *
 * Without a matching rule the model echoes the user's message, and if tools
 * named in `HARNESS_MOCK_AUTO_TOOL` exist it calls them first.
 */
export interface MockStep {
  toolCalls?: Array<{ name: string; args: unknown }>;
  text?: string;
}

export interface MockRule {
  match: string;
  steps: MockStep[];
}

export interface MockScript {
  rules: MockRule[];
}

function lastUserText(options: LanguageModelV4CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const m = options.prompt[i];
    if (m && m.role === "user") {
      return m.content
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("")
        .trim();
    }
  }
  return "";
}

/** Number of assistant turns after the latest user message = current step index. */
function stepIndex(options: LanguageModelV4CallOptions): number {
  let n = 0;
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const m = options.prompt[i];
    if (!m) continue;
    if (m.role === "user") break;
    if (m.role === "assistant") n++;
  }
  return n;
}

function lastToolResult(options: LanguageModelV4CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const m = options.prompt[i];
    if (m && m.role === "tool") {
      const part = m.content.find((p) => p.type === "tool-result");
      if (part && part.type === "tool-result") {
        const out = part.output as { type: string; value?: unknown };
        return typeof out.value === "string" ? out.value : JSON.stringify(out.value ?? out);
      }
    }
  }
  return "";
}

/** Text of the system + user messages the model received in this call (lets tests observe redaction). */
export function promptDigest(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join("")))
    .join("\n");
}

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };

export function createMockModel(script: MockScript = { rules: [] }, modelId = "scripted"): LanguageModelV4 & { calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = [];
  const plan = (options: LanguageModelV4CallOptions): MockStep | undefined => {
    const text = lastUserText(options);
    const rule = script.rules.find((r) => new RegExp(r.match, "i").test(text));
    const idx = stepIndex(options);
    if (rule) return rule.steps[idx] ?? { text: "（脚本已结束）" };
    return idx === 0 ? { text: `收到：${text}` } : { text: "完成。" };
  };
  const toParts = (options: LanguageModelV4CallOptions): LanguageModelV4StreamPart[] => {
    const step = plan(options) ?? { text: "" };
    const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
    const available = new Set((options.tools ?? []).map((t) => t.name));
    if (step.toolCalls?.length) {
      step.toolCalls.forEach((call, i) => {
        if (!available.has(call.name)) return;
        parts.push({ type: "tool-call", toolCallId: `mock_call_${Date.now()}_${i}`, toolName: call.name, input: JSON.stringify(call.args ?? {}) });
      });
      if (parts.length > 1) {
        parts.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage });
        return parts;
      }
      // Requested tools are unavailable: answer honestly instead of calling them.
      const missing = step.toolCalls.map((c) => c.name).join(", ");
      step.text = `我现在没有可用的工具（${missing}），无法完成这个请求。`;
    }
    const text = (step.text ?? "").replace("{{result}}", lastToolResult(options)).replace("{{user}}", lastUserText(options));
    const chunks = text.match(/[\s\S]{1,24}/g) ?? [""];
    parts.push({ type: "text-start", id: "t0" });
    for (const c of chunks) parts.push({ type: "text-delta", id: "t0", delta: c });
    parts.push({ type: "text-end", id: "t0" });
    parts.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
    return parts;
  };
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId,
    supportedUrls: {},
    calls,
    async doGenerate(options) {
      calls.push(options);
      const parts = toParts(options);
      const content = parts.flatMap((p): LanguageModelV4Content[] => {
        if (p.type === "tool-call") return [p];
        if (p.type === "text-delta") return [{ type: "text", text: p.delta }];
        return [];
      });
      const finish = parts.find((p) => p.type === "finish");
      return {
        content,
        finishReason: finish && finish.type === "finish" ? finish.finishReason : { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
    async doStream(options) {
      calls.push(options);
      if (options.abortSignal?.aborted) throw new Error("aborted");
      const parts = toParts(options);
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  };
}
