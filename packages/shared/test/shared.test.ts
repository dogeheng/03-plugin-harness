import { describe, expect, it } from "vitest";
import { parseJsonc, redact, redactDeep, registerSecretValue, resolvePaths, withTimeout, HarnessError, ErrorCode } from "../src/index.ts";

describe("resolvePaths", () => {
  it("puts everything under HARNESS_HOME when set", () => {
    const p = resolvePaths({ HARNESS_HOME: "/tmp/hx" });
    expect(p.dataDir).toBe("/tmp/hx/data");
    expect(p.logsDir).toBe("/tmp/hx/logs");
    expect(p.configFile).toBe("/tmp/hx/config.jsonc");
    expect(p.dbFile).toBe("/tmp/hx/data/harness.db");
    expect(p.socketPath).toBe("/tmp/hx/data/run/harnessd.sock");
  });

  it("uses macOS conventions by default", () => {
    const p = resolvePaths({});
    expect(p.dataDir).toMatch(/Library\/Application Support\/Harness$/);
    expect(p.logsDir).toMatch(/Library\/Logs\/Harness$/);
    expect(p.configFile).toMatch(/\.config\/harness\/config\.jsonc$/);
  });

  it("falls back to a short socket path when sun_path would overflow", () => {
    const long = `/tmp/${"x".repeat(120)}`;
    const p = resolvePaths({ HARNESS_HOME: long });
    expect(Buffer.byteLength(p.socketPath)).toBeLessThanOrEqual(100);
    expect(p.socketPath).toMatch(/harnessd-[0-9a-f]{12}\.sock$/);
  });
});

describe("redact", () => {
  it("masks registered secret values anywhere in a string", () => {
    registerSecretValue("super-secret-value-123");
    expect(redact("token=super-secret-value-123;")).toBe("token=[REDACTED:secret];");
  });

  it("masks well-known key formats even if unregistered", () => {
    const fake = `sk-or-v1-${"a1".repeat(32)}`;
    expect(redact(`key ${fake} end`)).toBe("key [REDACTED:openrouter_key] end");
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Authorization: Bearer [REDACTED]");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED:private_key]");
  });

  it("redacts nested objects and sensitive key names", () => {
    const out = redactDeep({ apiKey: "short", nested: { list: [`sk-ant-${"x".repeat(20)}`] }, ok: 1 });
    expect(out).toEqual({ apiKey: "[REDACTED]", nested: { list: ["[REDACTED:anthropic_key]"] }, ok: 1 });
  });
});

describe("parseJsonc", () => {
  it("handles comments, trailing commas and comment-like text inside strings", () => {
    const v = parseJsonc<Record<string, unknown>>(`{
      // line comment
      "url": "http://example.com/path", /* block */
      "pattern": "a,]",
      "list": [1, 2, 3,],
    }`);
    expect(v).toEqual({ url: "http://example.com/path", pattern: "a,]", list: [1, 2, 3] });
  });

  it("keeps escaped quotes", () => {
    expect(parseJsonc(`{"a": "say \\"hi\\" // not a comment"}`)).toEqual({ a: 'say "hi" // not a comment' });
  });
});

describe("withTimeout", () => {
  it("rejects with the provided error after the deadline", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, () => new HarnessError(ErrorCode.Timeout, "late"))).rejects.toMatchObject({ code: ErrorCode.Timeout });
  });
  it("resolves when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 50, () => new Error("x"))).resolves.toBe(7);
  });
});
