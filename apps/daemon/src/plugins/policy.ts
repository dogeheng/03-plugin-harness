import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { checkSpawn, isExplicitHost, matchHost, matchPath, normalizeSpawnScope, sensitiveReason, type SpawnRule } from "@harness/manifest";
import type { HarnessPaths } from "@harness/shared";
import type { Grant, PluginRepo } from "./repo.ts";

export type Decision = { ok: true; grantIds: string[] } | { ok: false; reason: string };

export interface PolicyContext {
  pluginId: string;
  pluginData: string;
  /** Workspaces of sessions currently calling this plugin (plus the default workspace). */
  workspaces: Array<string | null>;
}

/** Temporary "allow once" grants, kept in memory only. */
interface TempGrant {
  pluginId: string;
  permission: string;
  scope: unknown;
  expiresAt: number;
}

/** Resolves symlinks so a link inside the workspace cannot point at ~/.ssh. Non-existent leaves are resolved via their parent. */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return resolve(realpathSync(dirname(abs)), abs.slice(dirname(abs).length + 1));
    } catch {
      return abs;
    }
  }
}

export class Policy {
  private readonly repo: PluginRepo;
  private readonly paths: HarnessPaths;
  private readonly home: string;
  private readonly temp: TempGrant[] = [];
  /** Built-in grants every plugin has implicitly. */
  private readonly implicit: Array<Omit<Grant, "id" | "grantedAt" | "lastUsedAt" | "source">> = [
    { permission: "fs.read", scope: ["${pluginData}/**"] },
    { permission: "fs.write", scope: ["${pluginData}/**"] },
  ];

  constructor(repo: PluginRepo, paths: HarnessPaths, home = homedir()) {
    this.repo = repo;
    this.paths = paths;
    // Canonical, so comparisons with canonicalised target paths hold even if $HOME is a symlink.
    this.home = canonicalPath(home);
  }

  grants(pluginId: string): Grant[] {
    return this.repo.grants(pluginId);
  }

  private scopesFor(pluginId: string, permission: string): Array<{ id: string; scope: unknown }> {
    const now = Date.now();
    for (let i = this.temp.length - 1; i >= 0; i--) if ((this.temp[i]?.expiresAt ?? 0) < now) this.temp.splice(i, 1);
    return [
      ...this.implicit.filter((g) => g.permission === permission).map((g) => ({ id: "implicit", scope: g.scope })),
      ...this.repo
        .grants(pluginId)
        .filter((g) => g.permission === permission)
        .map((g) => ({ id: g.id, scope: g.scope })),
      ...this.temp.filter((t) => t.pluginId === pluginId && t.permission === permission).map((t) => ({ id: "once", scope: t.scope })),
    ];
  }

  has(pluginId: string, permission: string): boolean {
    return this.scopesFor(pluginId, permission).some((s) => s.id !== "implicit");
  }

  allowOnce(pluginId: string, permission: string, scope: unknown, ttlMs = 5 * 60_000): void {
    this.temp.push({ pluginId, permission, scope, expiresAt: Date.now() + ttlMs });
  }

  private used(ids: string[]): void {
    for (const id of ids) if (id.startsWith("grt_")) this.repo.touchGrant(id);
  }

  checkPath(ctx: PolicyContext, permission: "fs.read" | "fs.write", rawPath: string): Decision & { path?: string } {
    const path = canonicalPath(rawPath);
    const sensitive = sensitiveReason(path, {
      home: this.home,
      harnessDirs: [this.paths.dataDir, this.paths.logsDir, this.paths.cacheDir, dirname(this.paths.configFile)].map(canonicalPath).filter((d) => d !== this.home),
      ownPluginData: ctx.pluginData,
    });
    if (sensitive) return { ok: false, reason: sensitive };
    const matched: string[] = [];
    for (const s of this.scopesFor(ctx.pluginId, permission)) {
      const patterns = (Array.isArray(s.scope) ? s.scope : [s.scope]).filter((x): x is string => typeof x === "string");
      const workspaces = ctx.workspaces.length ? ctx.workspaces : [null];
      if (workspaces.some((w) => matchPath(patterns, path, { workspace: w ? canonicalPath(w) : null, pluginData: ctx.pluginData, home: this.home }))) matched.push(s.id);
    }
    if (!matched.length) return { ok: false, reason: `没有被授权${permission === "fs.read" ? "读取" : "写入"} ${path.replace(this.home, "~")}` };
    this.used(matched);
    return { ok: true, grantIds: matched, path };
  }

  checkHost(pluginId: string, url: URL): Decision {
    const matched = this.scopesFor(pluginId, "net.fetch")
      .filter((s) => matchHost((Array.isArray(s.scope) ? s.scope : [s.scope]).filter((x): x is string => typeof x === "string"), url))
      .map((s) => s.id);
    if (!matched.length) return { ok: false, reason: `没有被授权访问 ${url.host}` };
    this.used(matched);
    return { ok: true, grantIds: matched };
  }

  /** Whether a net.fetch grant names this host literally; only such hosts may resolve to private addresses. */
  isExplicitHost(pluginId: string, hostname: string): boolean {
    return this.scopesFor(pluginId, "net.fetch").some((s) =>
      isExplicitHost((Array.isArray(s.scope) ? s.scope : [s.scope]).filter((x): x is string => typeof x === "string"), hostname),
    );
  }

  checkSpawn(pluginId: string, cmd: string, args: string[]): Decision & { rule?: SpawnRule } {
    const scopes = this.scopesFor(pluginId, "process.spawn");
    const rules = scopes.flatMap((s) => normalizeSpawnScope(s.scope));
    const r = checkSpawn(rules, cmd, args);
    if (!r.ok) return r;
    const ids = scopes.filter((s) => normalizeSpawnScope(s.scope).some((x) => x.cmd === cmd)).map((s) => s.id);
    this.used(ids);
    return { ok: true, grantIds: ids, rule: r.rule };
  }

  checkName(pluginId: string, permission: string, name: string): Decision {
    const matched = this.scopesFor(pluginId, permission)
      .filter((s) => s.scope === undefined || s.scope === "*" || (Array.isArray(s.scope) && (s.scope.includes(name) || s.scope.includes("*"))))
      .map((s) => s.id);
    if (!matched.length) return { ok: false, reason: `没有被授权 ${permission}：${name}` };
    this.used(matched);
    return { ok: true, grantIds: matched };
  }

  checkFlag(pluginId: string, permission: string): Decision {
    const matched = this.scopesFor(pluginId, permission).map((s) => s.id);
    if (!matched.length) return { ok: false, reason: `没有被授予权限 ${permission}` };
    this.used(matched);
    return { ok: true, grantIds: matched };
  }
}
