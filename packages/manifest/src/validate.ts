import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@harness/protocol";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import picomatch from "picomatch";
import semver from "semver";
import { PERMISSIONS } from "./permissions.ts";
import { MANIFEST_SCHEMA } from "./schema.ts";
import { MANIFEST_FILE, type Manifest } from "./types.ts";

export type IssueCode =
  | "parse_error"
  | "schema"
  | "invalid_id"
  | "invalid_version"
  | "incompatible_engine"
  | "incompatible_protocol"
  | "missing_entry"
  | "missing_file"
  | "unknown_permission"
  | "duplicate"
  | "activation"
  | "hook_permission"
  | "panel_permission"
  | "limits"
  | "config_schema"
  | "path_escape";

export interface Issue {
  code: IssueCode;
  path: string;
  message: string;
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  manifest?: Manifest;
  errors: Issue[];
  warnings: Issue[];
  /** True when the manifest is well-formed but targets another host/protocol version. */
  incompatible: boolean;
}

/** Host-wide upper bounds; manifests may only tighten them (report 4.2 / 7.1). */
export const HOST_LIMITS = { callTimeoutMs: 600_000, memoryMb: 512, hookTimeoutMs: 5_000 };

const ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2,}$/;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(MANIFEST_SCHEMA as object);

function ajvToIssues(errors: ErrorObject[] | null | undefined, raw: unknown): Issue[] {
  return (errors ?? []).map((e) => {
    const path = e.instancePath || "/";
    if (e.keyword === "enum" && /^\/permissions\/(required|optional)\/\d+\/id$/.test(path)) {
      const value = path.split("/").slice(1).reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], raw);
      return {
        code: "unknown_permission" as const,
        path,
        message: `未知权限「${String(value)}」`,
        hint: `可用权限：${((e.params as { allowedValues: unknown[] }).allowedValues ?? []).join("、")}`,
      };
    }
    let message = e.message ?? "不符合清单格式";
    let hint: string | undefined;
    switch (e.keyword) {
      case "required":
        message = `缺少必填字段 ${(e.params as { missingProperty: string }).missingProperty}`;
        break;
      case "additionalProperties":
        message = `未知字段 ${(e.params as { additionalProperty: string }).additionalProperty}`;
        hint = "检查拼写；清单不允许出现规范之外的字段";
        break;
      case "enum":
        message = `取值无效，只能是：${((e.params as { allowedValues: unknown[] }).allowedValues ?? []).join(" | ")}`;
        break;
      case "pattern":
        message = `格式不正确（需要匹配 ${(e.params as { pattern: string }).pattern}）`;
        if (path.includes("/tools/")) hint = "工具名只能用小写字母、数字和下划线，并以字母开头，例如 git_log";
        if (path.includes("/commands/") || path.includes("/panels/")) hint = "只能用小写字母、数字和连字符，例如 changelog";
        break;
      case "type":
        message = `类型应为 ${(e.params as { type: string }).type}`;
        break;
    }
    return { code: "schema" as const, path, message, hint };
  });
}

function insideDir(dir: string, rel: string): boolean {
  const full = normalize(join(dir, rel));
  return full === normalize(dir) || full.startsWith(normalize(dir) + "/");
}

export interface ValidateOptions {
  hostVersion: string;
  /** Plugin directory; enables file existence checks. */
  dir?: string;
}

export function validateManifest(raw: unknown, opts: ValidateOptions): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  let incompatible = false;
  if (!validateSchema(raw)) {
    return { ok: false, errors: ajvToIssues(validateSchema.errors, raw), warnings, incompatible };
  }
  const m = raw as unknown as Manifest;

  if (!ID_RE.test(m.id)) errors.push({ code: "invalid_id", path: "/id", message: `插件 ID「${m.id}」不是反向域名格式`, hint: "例如 dev.yourname.my-plugin（至少三段，小写）" });
  if (!semver.valid(m.version)) errors.push({ code: "invalid_version", path: "/version", message: `版本号「${m.version}」不是合法的语义化版本`, hint: "例如 0.1.0" });

  const range = m.engines.harness;
  if (!semver.validRange(range)) errors.push({ code: "incompatible_engine", path: "/engines/harness", message: `engines.harness「${range}」不是合法的版本范围`, hint: '例如 ">=0.1.0 <1.0.0"' });
  else if (!semver.satisfies(opts.hostVersion, range, { includePrerelease: true })) {
    incompatible = true;
    errors.push({
      code: "incompatible_engine",
      path: "/engines/harness",
      message: `插件要求 Harness ${range}，当前版本是 ${opts.hostVersion}`,
      hint: "更新 Harness，或安装与当前版本兼容的插件版本",
    });
  }

  const rt = m.runtime;
  if (rt.type !== "none") {
    const protos = rt.protocol ?? (rt.type === "wasm" ? [1] : []);
    if (rt.type !== "wasm" && !protos.length) errors.push({ code: "schema", path: "/runtime/protocol", message: "缺少 runtime.protocol（插件支持的 HPP 版本）", hint: "填写 [1]" });
    else if (!protos.some((v) => (SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(v))) {
      incompatible = true;
      errors.push({
        code: "incompatible_protocol",
        path: "/runtime/protocol",
        message: `插件支持的协议版本 [${protos.join(", ")}] 与宿主支持的 [${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}] 没有交集`,
        hint: "用新版 SDK 重新构建插件",
      });
    }
    if (!rt.entry) errors.push({ code: "missing_entry", path: "/runtime/entry", message: "缺少 runtime.entry（插件入口文件）" });
  }

  // File checks.
  const fileRefs: Array<[string, string | undefined]> = [
    ["/runtime/entry", rt.type === "none" ? undefined : rt.entry],
    ["/icon", m.icon],
    ["/contributes/skills", m.contributes?.skills],
    ...(m.contributes?.panels ?? []).map((p, i): [string, string] => [`/contributes/panels/${i}/entry`, p.entry]),
  ];
  for (const [path, rel] of fileRefs) {
    if (!rel) continue;
    if (rel.startsWith("/") || !opts.dir || !insideDir(opts.dir, rel)) {
      if (rel.startsWith("/") || (opts.dir && !insideDir(opts.dir, rel))) errors.push({ code: "path_escape", path, message: `路径「${rel}」必须是插件目录内的相对路径` });
      continue;
    }
    if (!existsSync(join(opts.dir, rel))) {
      const isEntry = path === "/runtime/entry";
      errors.push({
        code: isEntry ? "missing_entry" : "missing_file",
        path,
        message: `找不到文件 ${rel}`,
        hint: isEntry
          ? "先构建插件（例如 pnpm build），或检查 runtime.entry 是否指向构建产物"
          : path.includes("/panels/")
            ? "面板需要先构建（pnpm build:plugins 会把 panels/<id>/ 构建到 dist/panels/<id>/），或检查 entry 路径"
            : undefined,
      });
    }
  }

  // Duplicates.
  const dup = (list: string[] | undefined, path: string, what: string) => {
    const seen = new Set<string>();
    for (const n of list ?? []) {
      if (seen.has(n)) errors.push({ code: "duplicate", path, message: `${what}「${n}」重复声明` });
      seen.add(n);
    }
  };
  const c = m.contributes ?? {};
  dup(c.tools?.map((t) => t.name), "/contributes/tools", "工具");
  dup(c.commands?.map((t) => t.name), "/contributes/commands", "命令");
  dup(c.panels?.map((t) => t.id), "/contributes/panels", "面板");
  dup(c.hooks?.map((h) => h.event), "/contributes/hooks", "钩子事件");

  // Permissions.
  const required = m.permissions?.required ?? [];
  const optional = m.permissions?.optional ?? [];
  [...required.map((p, i) => [p, `/permissions/required/${i}`] as const), ...optional.map((p, i) => [p, `/permissions/optional/${i}`] as const)].forEach(([p, path]) => {
    if (!PERMISSIONS[p.id]) errors.push({ code: "unknown_permission", path: `${path}/id`, message: `未知权限「${p.id}」`, hint: `可用权限：${Object.keys(PERMISSIONS).join("、")}` });
    const kind = PERMISSIONS[p.id]?.scopeKind;
    if (kind && kind !== "none" && kind !== "budget" && p.scope === undefined && path.includes("required"))
      errors.push({ code: "schema", path: `${path}/scope`, message: `必需权限 ${p.id} 必须声明 scope`, hint: "必需权限要写清楚范围，例如 fs.read 写 [\"${workspace}/**\"]" });
  });
  const has = (id: string) => required.some((p) => p.id === id);

  // Hooks need explicit permissions.
  // A critical hook only fails closed while hooks.critical is granted, so declaring it
  // as optional is valid: the user opts in to fail-closed behaviour.
  const declaredAnywhere = (id: string) => [...(m.permissions?.required ?? []), ...(m.permissions?.optional ?? [])].some((p) => p.id === id);
  for (const [i, h] of (c.hooks ?? []).entries()) {
    if (h.critical && !declaredAnywhere("hooks.critical"))
      errors.push({
        code: "hook_permission",
        path: `/contributes/hooks/${i}/critical`,
        message: `关键钩子 ${h.event} 需要声明权限 hooks.critical`,
        hint: "在 permissions.required（安装即生效）或 permissions.optional（用户授予后才生效）中加入 hooks.critical，并写明理由",
      });
    if (h.timeoutMs && h.timeoutMs > HOST_LIMITS.hookTimeoutMs)
      errors.push({ code: "limits", path: `/contributes/hooks/${i}/timeoutMs`, message: `钩子超时 ${h.timeoutMs}ms 超过宿主上限 ${HOST_LIMITS.hookTimeoutMs}ms` });
  }
  if ((c.panels ?? []).length && !declaredAnywhere("ui.panel"))
    errors.push({
      code: "panel_permission",
      path: "/contributes/panels",
      message: "声明了面板，但没有声明权限 ui.panel",
      hint: "在 permissions.required 中加入 { \"id\": \"ui.panel\", \"reason\": \"…\" }；面板只有在 ui.panel 被授予时才会显示",
    });
  if ((c.hooks ?? []).length && !has("session.modify"))
    warnings.push({ code: "hook_permission", path: "/permissions", message: "没有声明 session.modify：钩子只能放行或阻断，返回 modify 会被宿主拒绝" });

  // Activation events must point at declared contributions.
  for (const [i, ev] of (m.activation ?? []).entries()) {
    const [kind, target = ""] = ev.split(/:(.*)/s);
    const path = `/activation/${i}`;
    if (kind === "onTool" && !(c.tools ?? []).some((t) => picomatch.isMatch(t.name, target)))
      errors.push({ code: "activation", path, message: `激活事件 ${ev} 没有匹配到任何已声明的工具` });
    if (kind === "onCommand" && !(c.commands ?? []).some((t) => t.name === target)) errors.push({ code: "activation", path, message: `激活事件 ${ev} 引用了未声明的命令` });
    if (kind === "onPanel" && !(c.panels ?? []).some((t) => t.id === target)) errors.push({ code: "activation", path, message: `激活事件 ${ev} 引用了未声明的面板` });
    if (kind === "onHook" && !(c.hooks ?? []).some((t) => t.event === target)) errors.push({ code: "activation", path, message: `激活事件 ${ev} 引用了未声明的钩子` });
    if (kind === "onStartup") warnings.push({ code: "activation", path, message: "onStartup 会在宿主启动时立即拉起插件，拖慢启动；能用按需激活就不要用它" });
  }

  // Limits may only tighten the host limits.
  for (const [k, max] of Object.entries(HOST_LIMITS)) {
    const v = (m.limits as Record<string, number> | undefined)?.[k];
    if (v !== undefined && v > max) errors.push({ code: "limits", path: `/limits/${k}`, message: `${k}=${v} 超过宿主上限 ${max}`, hint: "limits 只能比宿主默认值更严格" });
  }
  for (const [i, t] of (c.tools ?? []).entries()) {
    if (t.timeoutMs && t.timeoutMs > HOST_LIMITS.callTimeoutMs) errors.push({ code: "limits", path: `/contributes/tools/${i}/timeoutMs`, message: `工具超时 ${t.timeoutMs}ms 超过上限 ${HOST_LIMITS.callTimeoutMs}ms` });
    try {
      ajv.compile(t.inputSchema);
    } catch (e) {
      errors.push({ code: "config_schema", path: `/contributes/tools/${i}/inputSchema`, message: `inputSchema 不是合法的 JSON Schema：${(e as Error).message}` });
    }
    if ((t.inputSchema as { type?: string }).type !== "object") errors.push({ code: "schema", path: `/contributes/tools/${i}/inputSchema/type`, message: "工具的 inputSchema 顶层必须是 object" });
  }

  if (m.configSchema) {
    try {
      ajv.compile(m.configSchema);
    } catch (e) {
      errors.push({ code: "config_schema", path: "/configSchema", message: `configSchema 不是合法的 JSON Schema：${(e as Error).message}` });
    }
  }

  if (!c.tools?.length && !c.commands?.length && !c.hooks?.length && !c.panels?.length && !c.skills)
    warnings.push({ code: "schema", path: "/contributes", message: "插件没有贡献任何能力（工具、命令、钩子、面板或 Skills）" });

  return { ok: errors.length === 0, manifest: m, errors, warnings, incompatible };
}

export function readManifest(dir: string): { raw?: unknown; error?: Issue } {
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file) || !statSync(file).isFile()) return { error: { code: "parse_error", path: "/", message: `目录中没有 ${MANIFEST_FILE}：${dir}`, hint: "插件目录的根部必须有清单文件" } };
  try {
    return { raw: JSON.parse(readFileSync(file, "utf8")) };
  } catch (e) {
    return { error: { code: "parse_error", path: "/", message: `${MANIFEST_FILE} 不是合法的 JSON：${(e as Error).message}` } };
  }
}

export function loadAndValidate(dir: string, hostVersion: string): ValidationResult {
  const { raw, error } = readManifest(dir);
  if (error) return { ok: false, errors: [error], warnings: [], incompatible: false };
  return validateManifest(raw, { hostVersion, dir });
}

export function formatIssues(r: Pick<ValidationResult, "errors" | "warnings">): string {
  const lines: string[] = [];
  for (const e of r.errors) lines.push(`✗ ${e.path}  ${e.message}${e.hint ? `\n    → ${e.hint}` : ""}`);
  for (const w of r.warnings) lines.push(`! ${w.path}  ${w.message}${w.hint ? `\n    → ${w.hint}` : ""}`);
  return lines.join("\n");
}

/** Builds default values for a config schema (top-level properties only). */
export function configDefaults(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = (schema?.properties ?? {}) as Record<string, { default?: unknown; "x-secret"?: boolean }>;
  for (const [k, v] of Object.entries(props)) if (v.default !== undefined && !v["x-secret"]) out[k] = v.default;
  return out;
}

/** Keys of the config schema marked as secrets (stored in the Keychain, never in plain config). */
export function secretKeys(schema: Record<string, unknown> | undefined): string[] {
  const props = (schema?.properties ?? {}) as Record<string, { "x-secret"?: boolean }>;
  return Object.entries(props)
    .filter(([, v]) => v["x-secret"] === true)
    .map(([k]) => k);
}

export function validateConfig(schema: Record<string, unknown> | undefined, values: unknown): Issue[] {
  if (!schema) return [];
  const v = ajv.compile(schema);
  if (v(values)) return [];
  return ajvToIssues(v.errors, values).map((i) => ({ ...i, code: "config_schema" as const }));
}
