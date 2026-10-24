import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { sensitiveReason } from "@harness/manifest";
import type { CommandRunResult } from "@harness/protocol";
import { ErrorCode, HarnessError, type HarnessPaths } from "@harness/shared";

export type ActionMode = "create" | "overwrite" | "prepend";

/** What clients see: the plugin proposes, the user decides, the host writes. */
export interface ActionView {
  id: string;
  pluginId: string;
  label: string;
  kind: "write-file";
  /** Path relative to the workspace. */
  path: string;
  mode: ActionMode;
  bytes: number;
  exists: boolean;
  preview: string;
  expiresAt: string;
}

interface Pending extends ActionView {
  workspace: string;
  content: string;
  expires: number;
}

export interface AppliedAction {
  id: string;
  pluginId: string;
  path: string;
  absPath: string;
  mode: ActionMode;
  bytes: number;
}

const MAX_CONTENT = 1024 * 1024;

/**
 * Host-side actions proposed by plugin commands. Plugins never get write access for
 * this: the host keeps the proposal, shows it to the user and performs the write
 * itself after explicit confirmation, confined to the workspace.
 */
export class ActionStore {
  private readonly pending = new Map<string, Pending>();
  private readonly paths: HarnessPaths;
  private readonly ttlMs: number;
  private readonly home: string;

  constructor(paths: HarnessPaths, opts: { ttlMs?: number; home?: string } = {}) {
    this.paths = paths;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.home = opts.home ?? homedir();
  }

  /** Validates proposed actions; invalid ones are dropped with a reason. */
  register(pluginId: string, workspace: string | null, actions: CommandRunResult["actions"]): { views: ActionView[]; problems: string[] } {
    this.sweep();
    const views: ActionView[] = [];
    const problems: string[] = [];
    for (const a of actions ?? []) {
      const label = typeof a?.label === "string" ? a.label.slice(0, 120) : "写入文件";
      if (a?.kind !== "write-file") {
        problems.push(`不支持的动作类型 ${String(a?.kind)}`);
        continue;
      }
      if (!workspace) {
        problems.push(`「${label}」需要工作区：用 --workspace 指定，或运行 harness config set workspace <目录>`);
        continue;
      }
      if (typeof a.content !== "string" || Buffer.byteLength(a.content) > MAX_CONTENT) {
        problems.push(`「${label}」的内容无效或超过 1MB`);
        continue;
      }
      const mode: ActionMode = (a as { mode?: ActionMode }).mode ?? "create";
      if (!["create", "overwrite", "prepend"].includes(mode)) {
        problems.push(`「${label}」的写入方式 ${String(mode)} 无效`);
        continue;
      }
      let abs: string;
      try {
        abs = this.resolveTarget(workspace, a.path);
      } catch (e) {
        problems.push(`「${label}」被拒绝：${(e as Error).message}`);
        continue;
      }
      const id = `act_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const expires = Date.now() + this.ttlMs;
      const view: Pending = {
        id,
        pluginId,
        label,
        kind: "write-file",
        path: relative(realpathSync(workspace), abs),
        mode,
        bytes: Buffer.byteLength(a.content),
        exists: existsSync(abs),
        preview: a.content.slice(0, 2000),
        expiresAt: new Date(expires).toISOString(),
        workspace,
        content: a.content,
        expires,
      };
      this.pending.set(id, view);
      const { workspace: _w, content: _c, expires: _e, ...pub } = view;
      views.push(pub);
    }
    return { views, problems };
  }

  get(id: string): ActionView | undefined {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) return undefined;
    const { workspace: _w, content: _c, expires: _e, ...pub } = p;
    return pub;
  }

  /** Performs the write. Single use: an action can be applied at most once. */
  apply(id: string): AppliedAction {
    this.sweep();
    const p = this.pending.get(id);
    if (!p) throw new HarnessError(ErrorCode.InvalidParams, "动作不存在或已过期（10 分钟内有效）", { hint: "重新运行命令生成新的动作" });
    this.pending.delete(id);
    const abs = this.resolveTarget(p.workspace, p.path); // re-check right before writing
    const exists = existsSync(abs);
    let data = p.content;
    if (p.mode === "create" && exists) throw new HarnessError(ErrorCode.InvalidParams, `${p.path} 已存在，插件请求的写入方式是“仅新建”`);
    if (p.mode === "prepend" && exists) data = prependUnderTitle(readFileSync(abs, "utf8"), p.content);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data, { mode: 0o644 });
    return { id, pluginId: p.pluginId, path: p.path, absPath: abs, mode: p.mode, bytes: Buffer.byteLength(data) };
  }

  /** Resolves a workspace-relative path, refusing escapes, symlinks and sensitive places. */
  private resolveTarget(workspace: string, rel: unknown): string {
    if (typeof rel !== "string" || !rel.trim() || rel.includes("\0")) throw new Error("路径无效");
    if (isAbsolute(rel)) throw new Error("只能写入工作区内的相对路径");
    const norm = normalize(rel);
    const segs = norm.split(sep);
    if (segs.includes("..")) throw new Error("路径不能包含 ..");
    if (segs.includes(".git")) throw new Error("不允许写入 .git 目录");
    let root: string;
    try {
      root = realpathSync(workspace);
    } catch {
      throw new Error(`工作区 ${workspace} 不存在`);
    }
    const abs = join(root, norm);
    if (!abs.startsWith(root + sep)) throw new Error("路径超出了工作区");
    // The nearest existing ancestor must resolve inside the workspace (no symlinked dirs).
    let probe = dirname(abs);
    while (!existsSync(probe) && probe.startsWith(root + sep)) probe = dirname(probe);
    const probeReal = realpathSync(probe);
    if (probeReal !== root && !probeReal.startsWith(root + sep)) throw new Error("路径经由符号链接指向了工作区之外");
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new Error("目标文件是符号链接");
    // Compare canonical paths on both sides (/var -> /private/var on macOS).
    const home = real(this.home);
    const sensitive = sensitiveReason(abs, {
      home,
      harnessDirs: [this.paths.dataDir, this.paths.logsDir, this.paths.cacheDir, dirname(this.paths.configFile)].map(real).filter((d) => d !== home),
      ownPluginData: join(this.paths.dataDir, "\0none"),
    });
    if (sensitive) throw new Error(sensitive);
    return abs;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expires < now) this.pending.delete(id);
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Inserts a new section below a leading "# Title" line (keeps-a-changelog style). */
export function prependUnderTitle(existing: string, section: string): string {
  const body = section.trim();
  const m = /^(# [^\n]*\n+)/.exec(existing);
  if (m && !body.startsWith("# ")) return `${m[1]}${body}\n\n${existing.slice(m[1].length)}`;
  return `${body}\n\n${existing}`;
}
