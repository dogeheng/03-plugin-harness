import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO } from "../helpers.ts";

/** Build bundled plugins and the Web UI so the browser never runs a stale build. */
export default function setup(): void {
  const rt = join(REPO, "scripts", "rt.sh");
  execFileSync(rt, ["node", join(REPO, "scripts", "build-plugins.ts")], { cwd: REPO, stdio: "pipe" });
  execFileSync(rt, ["vite", "build", "--logLevel", "warn"], { cwd: join(REPO, "apps", "web"), stdio: "pipe" });
}
