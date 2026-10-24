import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];
const files: string[] = [];

function check(file: string, specifier: string): void {
  const rel = relative(root, resolve(root, file)).replaceAll("\\", "/");
  const target = specifier.startsWith(".")
    ? relative(root, resolve(root, dirname(file), specifier)).replaceAll("\\", "/") : specifier;
  const host = /^(apps\/|@harness\/(daemon|cli|web)(\/|$))/.test(target);
  const plugin = target.startsWith("plugins/");
  if ((rel.startsWith("packages/") && (host || plugin)) || (rel.startsWith("plugins/") && host) || (rel.startsWith("apps/") && plugin)) {
    failures.push(`${rel}: forbidden dependency on ${specifier}`);
  }
}

function scan(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (/\.[cm]?[jt]sx?$/.test(file) && !file.endsWith(".d.ts")) files.push(file);
    else if (entry.name === "package.json") {
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) check(file, dep);
    }
  }
}
for (const dir of ["apps", "packages", "plugins"]) scan(join(root, dir));
// Parse runtime imports with the installed compiler, without evaluating or writing code.
const result = await build({ absWorkingDir: root, entryPoints: files, bundle: false, write: false, metafile: true, outdir: ".work/boundaries", logLevel: "silent" });
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) check(output.entryPoint!, dependency.path);
}
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log(`Dependency boundaries checked in ${files.length} source files.`);
