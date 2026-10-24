import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Filesystem layout used by Harness on macOS.
 *
 * Default (no HARNESS_HOME):
 *   data   ~/Library/Application Support/Harness
 *   logs   ~/Library/Logs/Harness
 *   cache  ~/Library/Caches/Harness
 *   config ~/.config/harness/config.jsonc
 *
 * With HARNESS_HOME set, everything lives below that directory, which keeps
 * tests and parallel dev instances fully isolated from the user's real data.
 */
export interface HarnessPaths {
  home: string;
  dataDir: string;
  logsDir: string;
  cacheDir: string;
  runDir: string;
  configFile: string;
  dbFile: string;
  daemonInfoFile: string;
  socketPath: string;
  pluginsStoreDir: string;
  pluginsDataDir: string;
  pluginLogsDir: string;
  catalogDir: string;
  blobsDir: string;
  sandboxProfilesDir: string;
}

/** macOS limits sun_path to 104 bytes including the terminator. */
const MAX_SOCKET_PATH = 100;

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): HarnessPaths {
  const override = env.HARNESS_HOME;
  const user = homedir();
  const dataDir = override ? join(override, "data") : join(user, "Library", "Application Support", "Harness");
  const logsDir = override ? join(override, "logs") : join(user, "Library", "Logs", "Harness");
  const cacheDir = override ? join(override, "cache") : join(user, "Library", "Caches", "Harness");
  const configFile = override ? join(override, "config.jsonc") : join(user, ".config", "harness", "config.jsonc");
  const runDir = join(dataDir, "run");
  let socketPath = join(runDir, "harnessd.sock");
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    const digest = createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
    socketPath = join(tmpdir().length < 60 ? tmpdir() : "/tmp", `harnessd-${digest}.sock`);
  }
  return {
    home: override ?? dataDir,
    dataDir,
    logsDir,
    cacheDir,
    runDir,
    configFile,
    dbFile: join(dataDir, "harness.db"),
    daemonInfoFile: join(runDir, "daemon.json"),
    socketPath,
    pluginsStoreDir: join(dataDir, "plugins", "store"),
    pluginsDataDir: join(dataDir, "plugins", "data"),
    pluginLogsDir: join(logsDir, "plugins"),
    catalogDir: join(dataDir, "catalog"),
    blobsDir: join(dataDir, "blobs"),
    sandboxProfilesDir: join(runDir, "sandbox"),
  };
}

/** Creates every directory of the layout with owner-only permissions. */
export function ensureLayout(paths: HarnessPaths): void {
  for (const dir of [
    paths.dataDir,
    paths.logsDir,
    paths.cacheDir,
    paths.runDir,
    paths.pluginsStoreDir,
    paths.pluginsDataDir,
    paths.pluginLogsDir,
    paths.catalogDir,
    paths.blobsDir,
    paths.sandboxProfilesDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
