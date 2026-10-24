import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES_DIR, forceRemove, waitFor } from "../../../test/helpers.ts";
import { startHost, type TestHost } from "../../../test/host.ts";

let host: TestHost | null = null;
let tmp = "";
afterEach(async () => {
  await host?.stop();
  host = null;
  if (tmp) forceRemove(tmp);
  tmp = "";
});

function devCopy(): string {
  tmp = mkdtempSync(join(tmpdir(), "hx-dev-"));
  const dir = join(tmp, "panel-probe");
  cpSync(join(FIXTURES_DIR, "panel-probe"), dir, { recursive: true });
  return dir;
}

describe("dev-mode hot reload", () => {
  it("reloads a linked plugin when one of its files changes", async () => {
    const dir = devCopy();
    host = await startHost();
    await host.plugins.install(dir, { dev: true });
    writeFileSync(join(dir, "panel", "extra.css"), "body{}");
    const ev = await waitFor(() => host?.events.find((e) => e.type === "plugin.state" && "detail" in e && String(e.detail).includes("已重新加载")), 3000);
    expect(String((ev as { detail: string }).detail)).toContain("extra.css");
  });

  it("a file change right before shutdown does not run a reload against the closed store", async () => {
    const dir = devCopy();
    host = await startHost();
    await host.plugins.install(dir, { dev: true });
    writeFileSync(join(dir, "panel", "late.css"), "body{}");
    await host.stop(); // the 300ms debounce timer is still pending here
    host = null;
    writeFileSync(join(dir, "panel", "later.css"), "body{}"); // and the watcher must be closed
    await new Promise((r) => setTimeout(r, 600));
    // Vitest fails the run on an unhandled rejection ("database is not open"); reaching here is the assertion.
    expect(true).toBe(true);
  });
});
