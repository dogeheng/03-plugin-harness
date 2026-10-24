import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandbox, type OsSandbox, shellQuote } from "../src/sandbox/seatbelt.ts";
import { forceRemove } from "../../../test/helpers.ts";

const NODE = process.execPath;
const RUNTIME_ROOT = dirname(dirname(NODE));
let fakeHome: string;
let sb: OsSandbox;

/** Runs a Node script inside the sandbox (without the Node permission model). */
async function runInSandbox(code: string, opts: { read?: string[]; write?: string[]; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(fakeHome, "work-"));
  const file = join(dir, "probe.cjs");
  writeFileSync(file, code);
  const w = await sb.wrap({ command: NODE, args: [file], env: opts.env ?? { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, readPaths: [RUNTIME_ROOT, dir, ...(opts.read ?? [])], writePaths: opts.write ?? [], id: "test.probe" });
  return new Promise<{ code: number | null; out: string; err: string; pid: number | undefined }>((done) => {
    const child = spawn(w.command, w.args, { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (c) => done({ code: c, out: out.trim(), err: err.trim(), pid: child.pid }));
  });
}

const tryRead = `const fs=require("fs");const r=(f)=>{try{fs.readFileSync(f);return "READ"}catch(e){return e.code}};`;
const tryWrite = `const w=(f)=>{try{require("fs").writeFileSync(f,"x");return "WROTE"}catch(e){return e.code}};`;

beforeAll(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), "hx-sbhome-"));
  mkdirSync(join(fakeHome, ".ssh"));
  writeFileSync(join(fakeHome, ".ssh", "id_ed25519"), "PRIVATE KEY");
  mkdirSync(join(fakeHome, "Documents", "secret"), { recursive: true });
  writeFileSync(join(fakeHome, "Documents", "secret", "notes.txt"), "private");
  mkdirSync(join(fakeHome, "project"));
  writeFileSync(join(fakeHome, "project", "README.md"), "hello");
  sb = createSandbox({ home: fakeHome });
  const st = await sb.ready();
  expect(st, `Seatbelt 不可用：${st.reason}`).toMatchObject({ mode: "seatbelt" });
});
afterAll(async () => {
  await sb?.dispose();
  forceRemove(fakeHome);
});

describe("Seatbelt sandbox (real sandbox-exec)", () => {
  it("denies the home directory except the paths put back", async () => {
    const r = await runInSandbox(`${tryRead}console.log(JSON.stringify({allowed:r(${JSON.stringify(join(fakeHome, "project", "README.md"))}),other:r(${JSON.stringify(join(fakeHome, "Documents", "secret", "notes.txt"))}),ssh:r(${JSON.stringify(join(fakeHome, ".ssh", "id_ed25519"))}),system:r("/etc/hosts")}))`, {
      read: [join(fakeHome, "project")],
    });
    expect(r.err).toBe("");
    expect(JSON.parse(r.out)).toEqual({ allowed: "READ", other: "EPERM", ssh: "EPERM", system: "READ" });
  });

  it("keeps sensitive paths denied even when the whole home is put back", async () => {
    const r = await runInSandbox(`${tryRead}console.log(JSON.stringify({docs:r(${JSON.stringify(join(fakeHome, "Documents", "secret", "notes.txt"))}),ssh:r(${JSON.stringify(join(fakeHome, ".ssh", "id_ed25519"))})}))`, { read: [fakeHome] });
    expect(JSON.parse(r.out)).toEqual({ docs: "READ", ssh: "EPERM" });
  });

  it("allows writes only to the listed paths (no shared scratch dir)", async () => {
    const data = mkdtempSync(join(fakeHome, "data-"));
    const outside = mkdtempSync(join(tmpdir(), "hx-sb-outside-"));
    // sandbox-runtime always allows /tmp/claude; make sure it exists so the check is real.
    const createdShared = !existsSync("/tmp/claude");
    if (createdShared) mkdirSync("/tmp/claude");
    try {
      const r = await runInSandbox(`${tryWrite}console.log(JSON.stringify({data:w(${JSON.stringify(join(data, "a"))}),home:w(${JSON.stringify(join(fakeHome, "evil"))}),tmp:w(${JSON.stringify(join(outside, "b"))}),claude:w("/tmp/claude/hx-test-shared")}))`, { read: [data], write: [data] });
      expect(JSON.parse(r.out)).toEqual({ data: "WROTE", home: "EPERM", tmp: "EPERM", claude: "EPERM" });
      expect(readFileSync(join(data, "a"), "utf8")).toBe("x");
      expect(existsSync("/tmp/claude/hx-test-shared")).toBe(false);
    } finally {
      forceRemove(outside);
      rmSync("/tmp/claude/hx-test-shared", { force: true });
      if (createdShared) rmSync("/tmp/claude", { recursive: true, force: true });
    }
  });

  it("blocks direct network access, including localhost", async () => {
    const server = createServer((s) => s.end("hi")).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await runInSandbox(`const s=require("net").connect(${port},"127.0.0.1");s.on("data",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",(e)=>{console.log(e.code);process.exit(0)});setTimeout(()=>{console.log("TIMEOUT");process.exit(0)},3000);`);
      expect(r.out).not.toBe("CONNECTED");
      expect(["EPERM", "ECONNREFUSED", "EACCES"]).toContain(r.out);
    } finally {
      server.close();
    }
  });

  it("passes exactly the requested environment (no proxy variables)", async () => {
    const r = await runInSandbox(`console.log(JSON.stringify(Object.keys(process.env).filter(k=>k!=="__CF_USER_TEXT_ENCODING").sort()))`, { env: { PATH: "/usr/bin:/bin", HARNESS_PLUGIN_ID: "x", LANG: "en_US.UTF-8" } });
    expect(JSON.parse(r.out)).toEqual(["HARNESS_PLUGIN_ID", "LANG", "PATH"]);
  });

  it("execs through the wrapper: the spawned pid is the target process", async () => {
    const r = await runInSandbox(`console.log(process.pid)`);
    expect(Number(r.out)).toBe(r.pid);
  });

  it("quotes arguments safely", async () => {
    expect(shellQuote("simple-arg_1.txt")).toBe("simple-arg_1.txt");
    expect(shellQuote("it's $(rm -rf ~)")).toBe(`'it'\\''s $(rm -rf ~)'`);
    const dir = mkdtempSync(join(fakeHome, "q-"));
    writeFileSync(join(dir, "echo.cjs"), "console.log(JSON.stringify(process.argv.slice(2)))");
    const w = await sb.wrap({ command: NODE, args: [join(dir, "echo.cjs"), "a b", "it's", "$(whoami)", "--x=\"y\""], env: { PATH: "/usr/bin:/bin" }, readPaths: [RUNTIME_ROOT, dir], writePaths: [], id: "test.quote" });
    const out = await new Promise<string>((done) => {
      const c = spawn(w.command, w.args, { env: w.env });
      let s = "";
      c.stdout.on("data", (d) => (s += d));
      c.on("close", () => done(s.trim()));
    });
    expect(JSON.parse(out)).toEqual(["a b", "it's", "$(whoami)", '--x="y"']);
  });
});

describe("degraded and disabled modes", () => {
  it("degrades with a reason when sandbox-exec is missing", async () => {
    const s = createSandbox({ sandboxExec: "/nonexistent/sandbox-exec", home: fakeHome });
    const st = await s.ready();
    expect(st.mode).toBe("degraded");
    expect(st.reason).toContain("/nonexistent/sandbox-exec");
    expect(s.active).toBe(false);
    // Pass-through: the command is returned unchanged.
    expect(await s.wrap({ command: "/usr/bin/true", args: ["x"], env: { A: "1" }, readPaths: [], writePaths: [], id: "t" })).toEqual({ command: "/usr/bin/true", args: ["x"], env: { A: "1" } });
    await s.dispose();
  });

  it("can be switched off explicitly", async () => {
    const s = createSandbox({ mode: "off" });
    expect((await s.ready()).mode).toBe("off");
    expect(s.active).toBe(false);
  });
});
