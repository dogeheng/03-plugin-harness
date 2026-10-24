import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO } from "./helpers.ts";

/** Rebuilds bundled plugins once per test run so tests never exercise a stale dist/. */
export default function setup(): void {
  execFileSync(join(REPO, "scripts", "rt.sh"), ["node", join(REPO, "scripts", "build-plugins.ts")], { cwd: REPO, stdio: "pipe" });
}
