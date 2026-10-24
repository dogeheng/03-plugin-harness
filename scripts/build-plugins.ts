/**
 * Builds plugins in ./plugins (and test fixtures) into self-contained bundles.
 *
 *   ./scripts/rt.sh node scripts/build-plugins.ts            # all plugins
 *   ./scripts/rt.sh node scripts/build-plugins.ts git-insight
 *   ./scripts/rt.sh node scripts/build-plugins.ts --dev      # inline source maps
 *
 * A TypeScript plugin is bundled together with the SDK and zod, so the plugin
 * process never needs to read anything outside its own directory (required by
 * the Node permission model the host launches it with).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { MANIFEST_SCHEMA } from "../packages/manifest/src/schema.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const only = args.filter((a) => !a.startsWith("--"));

// Editor support: "$schema": "../../packages/manifest/schema/harness.plugin.schema.json"
const schemaDir = join(ROOT, "packages", "manifest", "schema");
mkdirSync(schemaDir, { recursive: true });
writeFileSync(join(schemaDir, "harness.plugin.schema.json"), `${JSON.stringify(MANIFEST_SCHEMA, null, 2)}\n`);

/**
 * Builds UI panels: panels/<id>/{index.html, main.ts, *.css, assets} -> dist/panels/<id>/.
 * main.ts is bundled as a classic script for the browser (the panel SDK included), so the
 * panel works inside the sandboxed iframe without module/CORS concerns.
 */
export async function bundlePanels(dir: string, opts: { dev?: boolean } = {}): Promise<string[]> {
  const root = join(dir, "panels");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const id of readdirSync(root)) {
    const src = join(root, id);
    if (!existsSync(join(src, "index.html"))) continue;
    const dest = join(dir, "dist", "panels", id);
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true, filter: (f) => !/\.(ts|tsx)$/.test(f) });
    for (const entry of ["main.ts", "main.tsx"]) {
      if (!existsSync(join(src, entry))) continue;
      await build({
        entryPoints: [join(src, entry)],
        outfile: join(dest, "main.js"),
        bundle: true,
        platform: "browser",
        format: "iife",
        target: ["safari17", "chrome120"],
        sourcemap: opts.dev ? "inline" : false,
        legalComments: "eof",
        logLevel: "warning",
      });
    }
    out.push(join(dest, "index.html"));
  }
  return out;
}

export async function bundlePlugin(dir: string, opts: { dev?: boolean } = {}): Promise<string | null> {
  const manifestFile = join(dir, "harness.plugin.json");
  const src = join(dir, "src", "index.ts");
  if (!existsSync(manifestFile)) return null;
  await bundlePanels(dir, opts);
  if (!existsSync(src)) return null;
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { runtime: { type: string; entry?: string } };
  if (manifest.runtime.type !== "node" || !manifest.runtime.entry) return null;
  const outfile = join(dir, manifest.runtime.entry);
  await build({
    entryPoints: [src],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    sourcemap: opts.dev ? "inline" : false,
    legalComments: "eof",
    logLevel: "warning",
    banner: { js: "// Bundled by harness scripts/build-plugins.ts — do not edit; edit src/ instead." },
  });
  return outfile;
}

async function main() {
  const roots = [join(ROOT, "plugins"), join(ROOT, "test", "fixtures", "plugins")];
  const built: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (only.length && !only.includes(name)) continue;
      const out = await bundlePlugin(join(root, name), { dev });
      if (out) built.push(out.replace(`${ROOT}/`, ""));
      for (const p of existsSync(join(root, name, "dist", "panels")) ? readdirSync(join(root, name, "dist", "panels")) : []) built.push(`${root.replace(`${ROOT}/`, "")}/${name}/dist/panels/${p}/`);
    }
  }
  for (const b of built) console.log(`built ${b}`);
  if (!built.length) console.log("nothing to build");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
