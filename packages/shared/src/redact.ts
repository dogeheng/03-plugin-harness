/**
 * Process-wide secret redaction.
 *
 * Every secret value the host touches (provider API keys, plugin secrets) is
 * registered here, and every log line, error message and audit record passes
 * through `redact()` before it leaves the process. Pattern-based rules catch
 * common key formats even when a value was never registered.
 */
const registered = new Set<string>();

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-or-v1-[A-Za-z0-9]{16,}/g, "[REDACTED:openrouter_key]"],
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED:anthropic_key]"],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:api_key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private_key]"],
];

export function registerSecretValue(value: string | undefined | null): void {
  if (value && value.length >= 6) registered.add(value);
}

export function unregisterSecretValue(value: string): void {
  registered.delete(value);
}

export function redact(input: string): string {
  let out = input;
  for (const value of registered) {
    if (out.includes(value)) out = out.split(value).join("[REDACTED:secret]");
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Deeply redacts strings inside JSON-like values. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^(authorization|api[-_]?key|token|password|secret)$/i.test(k) && typeof v === "string" ? "[REDACTED]" : redactDeep(v);
    }
    return out as T;
  }
  return value;
}
