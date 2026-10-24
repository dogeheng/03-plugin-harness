import { readFileSync } from "node:fs";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { HarnessError, ErrorCode, parseJsonc } from "@harness/shared";
import type { HarnessConfig } from "../config.ts";
import { providerService, type SecretStore } from "../secrets/store.ts";
import { createMockModel, type MockScript } from "./mock.ts";

export interface ProviderInfo {
  id: string;
  label: string;
  kind: "openai-compatible" | "openai" | "anthropic" | "mock";
  defaultBaseURL?: string;
  requiresKey: boolean;
  exampleModels: string[];
}

/** Built-in providers. Additional providers arrive through the `providers` extension point (plugins). */
export const BUILTIN_PROVIDERS: ProviderInfo[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    defaultBaseURL: "https://openrouter.ai/api/v1",
    requiresKey: true,
    exampleModels: ["anthropic/claude-haiku-5.5", "openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash"],
  },
  { id: "openai", label: "OpenAI", kind: "openai", requiresKey: true, exampleModels: ["gpt-6-luna"] },
  { id: "anthropic", label: "Anthropic", kind: "anthropic", requiresKey: true, exampleModels: ["claude-haiku-5.5"] },
  {
    id: "openai-compatible",
    label: "OpenAI 兼容接口（如 Ollama、DeepSeek）",
    kind: "openai-compatible",
    defaultBaseURL: "http://127.0.0.1:11434/v1",
    requiresKey: false,
    exampleModels: ["llama3.3"],
  },
  { id: "mock", label: "脚本化离线模型（测试用）", kind: "mock", requiresKey: false, exampleModels: ["scripted"] },
];

export function getProviderInfo(id: string): ProviderInfo | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id);
}

export function loadMockScript(env: NodeJS.ProcessEnv = process.env): MockScript {
  const file = env.HARNESS_MOCK_SCRIPT;
  if (!file) return { rules: [] };
  return parseJsonc<MockScript>(readFileSync(file, "utf8"));
}

export async function createLanguageModel(config: HarnessConfig, secrets: SecretStore): Promise<LanguageModelV4> {
  const { provider, id } = config.model;
  const info = getProviderInfo(provider);
  if (!info) throw new HarnessError(ErrorCode.InvalidParams, `未知的模型提供方：${provider}`);
  const pc = config.providers[provider] ?? {};
  const apiKey = info.requiresKey || info.kind === "openai-compatible" ? await secrets.get(providerService(provider), "apiKey") : null;
  if (info.requiresKey && !apiKey) {
    throw new HarnessError(ErrorCode.PermissionDenied, `尚未配置 ${info.label} 的 API Key。请运行：harness auth set ${provider}`, {
      reason: "missing_api_key",
      provider,
    });
  }
  switch (info.kind) {
    case "mock":
      return createMockModel(loadMockScript(), id);
    case "openai":
      return createOpenAI({ apiKey: apiKey ?? undefined, baseURL: pc.baseURL }).chat(id) as unknown as LanguageModelV4;
    case "anthropic":
      return createAnthropic({ apiKey: apiKey ?? undefined, baseURL: pc.baseURL })(id) as unknown as LanguageModelV4;
    case "openai-compatible": {
      const headers: Record<string, string> = { ...(pc.headers ?? {}) };
      if (provider === "openrouter") {
        headers["X-Title"] ??= "Harness";
        headers["HTTP-Referer"] ??= "https://harness.local";
      }
      return createOpenAICompatible({
        name: provider,
        baseURL: pc.baseURL ?? info.defaultBaseURL ?? "",
        apiKey: apiKey ?? undefined,
        headers,
        includeUsage: true,
      }).chatModel(id) as unknown as LanguageModelV4;
    }
  }
}
