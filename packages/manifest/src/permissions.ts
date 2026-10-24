import { isAbsolute, normalize, sep } from "node:path";
import picomatch from "picomatch";

export type PermissionRisk = "low" | "medium" | "high";
export type ScopeKind = "paths" | "hosts" | "commands" | "names" | "budget" | "none";

export interface PermissionInfo {
  id: string;
  label: string;
  risk: PermissionRisk;
  scopeKind: ScopeKind;
  /** Plain-language explanation shown on the review page. */
  explain: string;
}

/** Permission catalog (report section 6.1). */
export const PERMISSIONS: Record<string, PermissionInfo> = {
  "fs.read": { id: "fs.read", label: "读取文件", risk: "medium", scopeKind: "paths", explain: "读取指定位置的文件和目录" },
  "fs.write": { id: "fs.write", label: "写入文件", risk: "high", scopeKind: "paths", explain: "在指定位置创建或修改文件" },
  "net.fetch": { id: "net.fetch", label: "访问网络", risk: "medium", scopeKind: "hosts", explain: "向指定的域名发起 HTTP 请求" },
  "process.spawn": { id: "process.spawn", label: "运行命令", risk: "high", scopeKind: "commands", explain: "在你的 Mac 上运行指定的命令" },
  "env.read": { id: "env.read", label: "读取环境变量", risk: "medium", scopeKind: "names", explain: "读取指定的环境变量" },
  "secrets.read": { id: "secrets.read", label: "读取密钥明文", risk: "high", scopeKind: "names", explain: "直接读取自己保存在钥匙串中的密钥明文" },
  "llm.invoke": { id: "llm.invoke", label: "调用模型", risk: "medium", scopeKind: "budget", explain: "使用你配置的模型生成内容，会产生费用" },
  "session.read": { id: "session.read", label: "读取会话", risk: "medium", scopeKind: "none", explain: "读取当前对话的消息摘要" },
  "session.modify": { id: "session.modify", label: "改写请求", risk: "high", scopeKind: "none", explain: "修改发给模型的消息、工具参数和工具结果" },
  "hooks.critical": { id: "hooks.critical", label: "关键拦截", risk: "high", scopeKind: "none", explain: "注册失败即阻断的拦截器，可以阻止任何操作" },
  "tools.invoke": { id: "tools.invoke", label: "调用其他工具", risk: "medium", scopeKind: "names", explain: "调用其他插件提供的工具" },
  "ui.panel": { id: "ui.panel", label: "显示面板", risk: "low", scopeKind: "none", explain: "在界面中显示自己的面板" },
  "ui.interact": { id: "ui.interact", label: "与你交互", risk: "low", scopeKind: "none", explain: "向你发送通知，或请你确认、输入内容" },
};

export function permissionInfo(id: string): PermissionInfo | undefined {
  return PERMISSIONS[id];
}

// ---- paths ------------------------------------------------------------------

export interface PathVars {
  workspace: string | null;
  pluginData: string;
  home: string;
}

/** Expands ${workspace} / ${pluginData} / ${home}. Returns null when a variable is unavailable. */
export function expandPathPattern(pattern: string, vars: PathVars): string | null {
  if (pattern.includes("${workspace}") && !vars.workspace) return null;
  const out = pattern
    .replaceAll("${workspace}", vars.workspace ?? "")
    .replaceAll("${pluginData}", vars.pluginData)
    .replaceAll("${home}", vars.home)
    .replace(/^~(?=\/|$)/, vars.home);
  return isAbsolute(out) ? out : null;
}

export function matchPath(patterns: string[], absPath: string, vars: PathVars): boolean {
  const p = normalize(absPath);
  for (const raw of patterns) {
    const pat = expandPathPattern(raw, vars);
    if (!pat) continue;
    if (pat.endsWith("/**") && (p === pat.slice(0, -3) || p === pat.slice(0, -2))) return true;
    if (picomatch.isMatch(p, pat, { dot: true })) return true;
  }
  return false;
}

export function isWithin(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent).replace(/\/+$/, "");
  return c === p || c.startsWith(p + sep);
}

/** Paths that are always denied regardless of granted scope (report 6.3). */
export function sensitivePaths(home: string): string[] {
  return [
    ".ssh",
    ".gnupg",
    ".aws",
    ".config/gh",
    ".config/harness",
    ".netrc",
    ".docker/config.json",
    ".kube",
    "Library/Keychains",
    "Library/Cookies",
    "Library/Safari",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Firefox",
    "Library/Application Support/com.apple.TCC",
    "Library/Messages",
    "Library/Mail",
  ].map((rel) => `${home}/${rel}`);
}

export interface SensitiveCheck {
  home: string;
  /** Harness-owned directories (data, logs, config); only `ownPluginData` inside them is allowed. */
  harnessDirs: string[];
  ownPluginData: string;
}

export function sensitiveReason(absPath: string, c: SensitiveCheck): string | null {
  if (isWithin(absPath, c.ownPluginData)) return null;
  for (const s of sensitivePaths(c.home)) if (isWithin(absPath, s)) return `敏感位置 ${s.replace(c.home, "~")} 始终禁止插件访问`;
  for (const d of c.harnessDirs) if (isWithin(absPath, d)) return "Harness 自身的数据目录禁止插件访问（插件只能访问自己的数据目录）";
  return null;
}

// ---- network ------------------------------------------------------------------

// ---- private / loopback addresses ------------------------------------------------

const PRIVATE_NAME = /^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.home\.arpa)$/i;

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

function privateIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network", 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (also Tailscale)
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Parses an IPv6 address (with optional embedded IPv4) into 8 16-bit groups. */
function parseIPv6(s: string): number[] | null {
  if (!s.includes(":")) return null;
  let str = s.split("%")[0] as string; // zone id
  let tail: number[] = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(str);
  if (v4) {
    const b = parseIPv4(v4[1] as string);
    if (!b) return null;
    tail = [((b[0] as number) << 8) | (b[1] as number), ((b[2] as number) << 8) | (b[3] as number)];
    str = str.slice(0, -(v4[1] as string).length);
    if (str.endsWith(":") && !str.endsWith("::")) str = str.slice(0, -1);
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN)) : []);
  const head = part(halves[0] as string);
  const rest = halves.length === 2 ? part(halves[1] as string) : [];
  const total = head.length + rest.length + tail.length;
  if ([...head, ...rest].some(Number.isNaN)) return null;
  if (halves.length === 1 && total !== 8) return null;
  if (total > 8) return null;
  return [...head, ...new Array(8 - total).fill(0), ...rest, ...tail];
}

function privateIPv6(g: number[]): boolean {
  const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (g.slice(0, 5).every((x) => x === 0) && (g5 === 0xffff || g5 === 0)) return privateIPv4(v4); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g0 === 0x64 && g[1] === 0xff9b) return privateIPv4(v4); // NAT64
  return false;
}

/**
 * True for loopback, private, link-local, CGNAT, multicast and reserved addresses
 * (IPv4 and IPv6, including IPv4-mapped forms) and for local-only names.
 * Accepts hostnames as produced by WHATWG URL (IPv6 in brackets, IPv4 normalised).
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const v4 = parseIPv4(h);
  if (v4) return privateIPv4(v4);
  const v6 = parseIPv6(h);
  if (v6) return privateIPv6(v6);
  return PRIVATE_NAME.test(h);
}

/** True when the hostname is an IP literal (v4 or v6). */
export function isIpLiteral(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return !!parseIPv4(h) || !!parseIPv6(h);
}

/** Host part of an allowlist pattern ("api.example.com:8443" -> "api.example.com"). */
function patternHost(raw: string): [string, string | undefined] {
  return raw.toLowerCase().split(/:(?=\d+$)/) as [string, string | undefined];
}

/** True when some pattern names this exact host (no wildcard): only those may reach private addresses. */
export function isExplicitHost(patterns: string[], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((raw) => {
    const [hp] = patternHost(raw);
    return hp !== "*" && !hp.startsWith("*.") && hp === host;
  });
}

/**
 * Host allowlist matching. Patterns: "api.example.com", "*.example.com" (subdomains
 * only), "example.com:8443", "*" (any public host). Private / loopback hosts must be
 * listed explicitly, so a broad grant can never be used to reach local services.
 */
export function matchHost(patterns: string[], url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const priv = isPrivateHost(host);
  for (const raw of patterns) {
    const [hp, pp] = patternHost(raw);
    if (pp && pp !== port) continue;
    if (!pp && port !== "443" && port !== "80") continue;
    if (hp === "*") {
      if (!priv) return true;
      continue;
    }
    if (hp.startsWith("*.")) {
      if (!priv && host.endsWith(hp.slice(1)) && host.length > hp.length - 1) return true;
      continue;
    }
    if (host === hp) return true;
  }
  return false;
}

// ---- processes ----------------------------------------------------------------

export interface SpawnRule {
  cmd: string;
  subcommands?: string[];
  denyArgs?: string[];
}

export function normalizeSpawnScope(scope: unknown): SpawnRule[] {
  const list = Array.isArray(scope) ? scope : scope === undefined ? [] : [scope];
  return list.flatMap((s): SpawnRule[] => {
    if (typeof s === "string") return [{ cmd: s }];
    if (s && typeof s === "object" && typeof (s as SpawnRule).cmd === "string") return [s as SpawnRule];
    return [];
  });
}

export type SpawnCheck = { ok: true; rule: SpawnRule } | { ok: false; reason: string };

export function checkSpawn(rules: SpawnRule[], cmd: string, args: string[]): SpawnCheck {
  if (!cmd || cmd.includes("/") || cmd.includes("\0")) return { ok: false, reason: `命令必须是不带路径的程序名：${cmd}` };
  if (args.some((a) => typeof a !== "string" || a.includes("\0"))) return { ok: false, reason: "参数中包含非法字符" };
  const rule = rules.find((r) => r.cmd === cmd);
  if (!rule) return { ok: false, reason: `没有被授权运行命令 ${cmd}` };
  if (rule.subcommands?.length) {
    const sub = args[0];
    if (!sub || sub.startsWith("-")) return { ok: false, reason: `${cmd} 的第一个参数必须是允许的子命令（${rule.subcommands.join("、")}），不能是全局选项` };
    if (!rule.subcommands.includes(sub)) return { ok: false, reason: `不允许运行 ${cmd} ${sub}，只允许：${rule.subcommands.join("、")}` };
  }
  for (const a of args) {
    for (const d of rule.denyArgs ?? []) {
      const longWithValue = d.startsWith("--") && a.startsWith(`${d}=`);
      const shortWithValue = /^-[a-zA-Z]$/.test(d) && !a.startsWith("--") && a.startsWith(d) && a.length > 2;
      if (a === d || longWithValue || shortWithValue) return { ok: false, reason: `参数 ${a} 被禁止（规则：${d}）` };
    }
  }
  return { ok: true, rule };
}

export function describeScope(id: string, scope: unknown): string {
  if (scope === undefined || scope === null) return "";
  if (id === "process.spawn")
    return normalizeSpawnScope(scope)
      .map((r) => `${r.cmd}${r.subcommands?.length ? ` ${r.subcommands.join("|")}` : ""}${r.denyArgs?.length ? `（禁止 ${r.denyArgs.join(" ")}）` : ""}`)
      .join("；");
  if (Array.isArray(scope)) return scope.map((s) => (typeof s === "string" ? humanizeScopeItem(id, s) : JSON.stringify(s))).join("、");
  if (typeof scope === "object") return JSON.stringify(scope);
  return String(scope);
}

/** "${workspace}/**" → "工作区内的所有文件"; "*" (hosts) → "任意公网主机（不含本机和内网）". */
export function humanizeScopeItem(id: string, item: string): string {
  if (id.startsWith("net.")) return item === "*" ? "任意公网主机（不含本机和内网）" : item;
  if (id.startsWith("fs.")) {
    const known: Record<string, string> = {
      "${workspace}/**": "工作区内的所有文件",
      "${workspace}": "工作区目录",
      "${pluginData}/**": "插件自己的数据目录",
    };
    if (known[item]) return known[item];
    return item.replace("${workspace}", "工作区").replace("${pluginData}", "插件数据目录").replace("${home}", "~");
  }
  return item;
}
