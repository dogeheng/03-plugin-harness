import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonc } from "@harness/shared";

export interface ProviderConfig {
  baseURL?: string;
  /** Extra non-secret headers. */
  headers?: Record<string, string>;
}

export interface HarnessConfig {
  model: { provider: string; id: string };
  providers: Record<string, ProviderConfig>;
  agent: { maxSteps: number; system?: string; totalTimeoutMs: number };
  server: { port: number };
  workspace?: string;
  /** Approval policy per tool risk level. */
  approvals: { read: "auto" | "ask"; network: "auto" | "ask"; write: "auto" | "ask"; exec: "auto" | "ask" };
  /** Directories scanned as local plugin catalogs, in addition to the built-in one. */
  catalogs: string[];
  /** OS sandbox (macOS Seatbelt) for plugin processes. "off" is for debugging only. */
  sandbox: "auto" | "off";
}

export const DEFAULT_CONFIG: HarnessConfig = {
  model: { provider: "openrouter", id: "anthropic/claude-haiku-5.5" },
  providers: {
    openrouter: { baseURL: "https://openrouter.ai/api/v1" },
  },
  agent: { maxSteps: 12, totalTimeoutMs: 10 * 60_000 },
  server: { port: 47821 },
  approvals: { read: "auto", network: "auto", write: "ask", exec: "ask" },
  catalogs: [],
  sandbox: "auto",
};

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out as T;
}

export function loadConfig(file: string): HarnessConfig {
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  const raw = parseJsonc<Record<string, unknown>>(readFileSync(file, "utf8"));
  delete raw.$schema;
  return merge(structuredClone(DEFAULT_CONFIG), raw);
}

/** Writes the config atomically (tmp + rename) with owner-only permissions. */
export function saveConfig(file: string, config: HarnessConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  const body = `// Harness configuration. Secrets are stored in the macOS Keychain, never here.\n${JSON.stringify(
    { $schema: "https://schemas.harness.local/config/v1.json", ...config },
    null,
    2,
  )}\n`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, file);
}
