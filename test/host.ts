import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent } from "@harness/shared";
import { Daemon, installSubsystems, MemorySecretStore, type ManagerOptions, type PanelServer, type PanelServerOptions, type PluginManager } from "../apps/daemon/src/index.ts";
import { createMockModel, type MockScript } from "../apps/daemon/src/models/mock.ts";
import { FIXTURES_DIR, forceRemove, PLUGINS_DIR } from "./helpers.ts";

export const FAST_TIMING = {
  handshakeMs: 1500,
  heartbeatMs: 150,
  heartbeatTimeoutMs: 100,
  heartbeatMisses: 2,
  backoffBaseMs: 30,
  backoffMaxMs: 200,
  crashWindowMs: 60_000,
  crashLimit: 3,
  stopGraceMs: 500,
  consecutiveTimeoutLimit: 3,
};

export interface TestHost {
  daemon: Daemon;
  plugins: PluginManager;
  panels: PanelServer;
  home: string;
  events: HostEvent[];
  /** Stops the daemon; removes HARNESS_HOME unless keep is true. */
  stop(keep?: boolean): Promise<void>;
}

/** A full daemon (API + plugin manager) in an isolated HARNESS_HOME. */
export async function startHost(opts: { script?: MockScript; plugins?: ManagerOptions; panels?: PanelServerOptions; env?: Record<string, string>; home?: string; webDist?: string | null } = {}): Promise<TestHost> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "hx-host-"));
  const model = createMockModel(opts.script ?? { rules: [] });
  const daemon = new Daemon({
    env: { ...process.env, HARNESS_HOME: home, HARNESS_SECRETS_BACKEND: "memory", HARNESS_LOG_LEVEL: "warn", ...opts.env },
    port: 0,
    secrets: new MemorySecretStore(),
    webDist: opts.webDist ?? null,
    modelFactory: async () => model,
  });
  const { plugins, panels } = installSubsystems(daemon, { plugins: { catalogDirs: [PLUGINS_DIR, FIXTURES_DIR], timing: FAST_TIMING, promptTimeoutMs: 3000, ...opts.plugins }, panels: { port: 0, ...opts.panels } });
  const events: HostEvent[] = [];
  daemon.bus.on((e) => events.push(e));
  await daemon.start();
  return {
    daemon,
    plugins,
    panels,
    home,
    events,
    stop: async (keep = false) => {
      await daemon.stop();
      if (!keep) forceRemove(home);
    },
  };
}

export const ctxFor = (workspace: string | null, sessionId = "s_test") => ({
  sessionId,
  turnId: "t_test",
  callId: `c_${Math.random().toString(36).slice(2)}`,
  workspace,
  signal: new AbortController().signal,
});

/** A small Git repository with a tag and three commits. */
export function makeRepo(parent: string = tmpdir()): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(parent, "hx-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.name", "Ada");
  g("config", "user.email", "ada@example.com");
  writeFileSync(join(dir, "a.txt"), "1\n");
  g("add", ".");
  g("commit", "-qm", "feat: first");
  g("tag", "v0.1.0");
  writeFileSync(join(dir, "a.txt"), "1\n2\n");
  g("commit", "-qam", "fix: second");
  g("commit", "-q", "--allow-empty", "-m", "docs: third");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
