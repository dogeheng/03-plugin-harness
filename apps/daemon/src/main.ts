import { existsSync, readFileSync } from "node:fs";
import { resolvePaths } from "@harness/shared";
import { Daemon } from "./daemon.ts";
import { installSubsystems } from "./index.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const paths = resolvePaths();
  if (existsSync(paths.daemonInfoFile)) {
    try {
      const info = JSON.parse(readFileSync(paths.daemonInfoFile, "utf8")) as { pid: number };
      if (info.pid !== process.pid && alive(info.pid)) {
        console.error(`harnessd is already running (pid ${info.pid})`);
        process.exit(3);
      }
    } catch {
      // stale or corrupt info file; overwritten on start
    }
  }
  const daemon = new Daemon({ logToStderr: process.argv.includes("--stderr") });
  installSubsystems(daemon);
  const { port, socketPath } = await daemon.start();
  console.log(JSON.stringify({ event: "ready", pid: process.pid, port, socketPath }));
  const shutdown = (signal: string) => {
    daemon.logger.info({ signal }, "shutting down");
    void daemon.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => daemon.logger.error({ err }, "uncaught exception"));
  process.on("unhandledRejection", (err) => daemon.logger.error({ err }, "unhandled rejection"));
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
