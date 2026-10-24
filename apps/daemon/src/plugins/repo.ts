import { newId, nowIso } from "@harness/shared";
import type { Db } from "../store/db.ts";

export interface PluginRow {
  id: string;
  version: string;
  enabled: number;
  source: string;
  installed_at: string;
  updated_at: string;
  previous_version: string | null;
  quarantined_reason: string | null;
  dev_path: string | null;
}

export interface VersionRow {
  plugin_id: string;
  version: string;
  path: string;
  manifest: string;
  source: string;
  verified: string;
  installed_at: string;
}

export interface GrantRow {
  id: string;
  plugin_id: string;
  permission: string;
  scope: string | null;
  version_range: string | null;
  workspace: string | null;
  source: "install" | "update" | "runtime" | "user";
  granted_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface Grant {
  id: string;
  permission: string;
  scope: unknown;
  source: GrantRow["source"];
  grantedAt: string;
  lastUsedAt: string | null;
}

/** KV quota per plugin (report 4.6). */
export const KV_QUOTA_BYTES = 50 * 1024 * 1024;

export class PluginRepo {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(): PluginRow[] {
    return this.db.prepare("SELECT * FROM plugins ORDER BY id").all() as unknown as PluginRow[];
  }

  get(id: string): PluginRow | undefined {
    return this.db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as unknown as PluginRow | undefined;
  }

  upsert(row: Omit<PluginRow, "installed_at" | "updated_at"> & { installed_at?: string }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO plugins(id, version, enabled, source, installed_at, updated_at, previous_version, quarantined_reason, dev_path)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, enabled = excluded.enabled, source = excluded.source,
           updated_at = excluded.updated_at, previous_version = excluded.previous_version,
           quarantined_reason = excluded.quarantined_reason, dev_path = excluded.dev_path`,
      )
      .run(row.id, row.version, row.enabled, row.source, row.installed_at ?? now, now, row.previous_version, row.quarantined_reason, row.dev_path);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, nowIso(), id);
  }

  setQuarantine(id: string, reason: string | null): void {
    this.db.prepare("UPDATE plugins SET quarantined_reason = ?, updated_at = ? WHERE id = ?").run(reason, nowIso(), id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM plugin_versions WHERE plugin_id = ?").run(id);
    this.db.prepare("DELETE FROM grants WHERE plugin_id = ?").run(id);
    this.db.prepare("DELETE FROM plugin_settings WHERE plugin_id = ?").run(id);
  }

  addVersion(v: Omit<VersionRow, "installed_at">): void {
    this.db
      .prepare(
        `INSERT INTO plugin_versions(plugin_id, version, path, manifest, source, verified, installed_at) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id, version) DO UPDATE SET path = excluded.path, manifest = excluded.manifest, source = excluded.source, verified = excluded.verified`,
      )
      .run(v.plugin_id, v.version, v.path, v.manifest, v.source, v.verified, nowIso());
  }

  getVersion(id: string, version: string): VersionRow | undefined {
    return this.db.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?").get(id, version) as unknown as VersionRow | undefined;
  }

  versions(id: string): VersionRow[] {
    return this.db.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY installed_at DESC").all(id) as unknown as VersionRow[];
  }

  deleteVersion(id: string, version: string): void {
    this.db.prepare("DELETE FROM plugin_versions WHERE plugin_id = ? AND version = ?").run(id, version);
  }

  // ---- grants -----------------------------------------------------------------

  grants(pluginId: string, opts: { includeRevoked?: boolean } = {}): Grant[] {
    const rows = this.db
      .prepare(`SELECT * FROM grants WHERE plugin_id = ? ${opts.includeRevoked ? "" : "AND revoked_at IS NULL"} ORDER BY granted_at`)
      .all(pluginId) as unknown as GrantRow[];
    return rows.map((r) => ({
      id: r.id,
      permission: r.permission,
      scope: r.scope === null ? undefined : JSON.parse(r.scope),
      source: r.source,
      grantedAt: r.granted_at,
      lastUsedAt: r.last_used_at,
      ...(opts.includeRevoked ? { revokedAt: r.revoked_at } : {}),
    }));
  }

  allGrants(): Array<Grant & { pluginId: string }> {
    const rows = this.db.prepare("SELECT * FROM grants WHERE revoked_at IS NULL ORDER BY plugin_id, permission").all() as unknown as GrantRow[];
    return rows.map((r) => ({
      id: r.id,
      pluginId: r.plugin_id,
      permission: r.permission,
      scope: r.scope === null ? undefined : JSON.parse(r.scope),
      source: r.source,
      grantedAt: r.granted_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  addGrant(pluginId: string, permission: string, scope: unknown, source: GrantRow["source"]): string {
    const id = newId("grt");
    this.db
      .prepare("INSERT INTO grants(id, plugin_id, permission, scope, source, granted_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(id, pluginId, permission, scope === undefined ? null : JSON.stringify(scope), source, nowIso());
    return id;
  }

  revokeGrant(id: string): boolean {
    const r = this.db.prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
    return Number(r.changes) > 0;
  }

  revokePermission(pluginId: string, permission: string): number {
    const r = this.db.prepare("UPDATE grants SET revoked_at = ? WHERE plugin_id = ? AND permission = ? AND revoked_at IS NULL").run(nowIso(), pluginId, permission);
    return Number(r.changes);
  }

  touchGrant(id: string): void {
    this.db.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").run(nowIso(), id);
  }

  // ---- settings -----------------------------------------------------------------

  settings(pluginId: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT values_json FROM plugin_settings WHERE plugin_id = ?").get(pluginId) as { values_json: string } | undefined;
    return row ? (JSON.parse(row.values_json) as Record<string, unknown>) : {};
  }

  setSettings(pluginId: string, values: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO plugin_settings(plugin_id, values_json, updated_at) VALUES(?, ?, ?) ON CONFLICT(plugin_id) DO UPDATE SET values_json = excluded.values_json, updated_at = excluded.updated_at")
      .run(pluginId, JSON.stringify(values), nowIso());
  }

  // ---- KV -------------------------------------------------------------------------

  kvGet(pluginId: string, key: string): unknown {
    const row = this.db.prepare("SELECT value, expires_at FROM plugin_kv WHERE plugin_id = ? AND key = ?").get(pluginId, key) as { value: Uint8Array; expires_at: string | null } | undefined;
    if (!row) return null;
    if (row.expires_at && row.expires_at < nowIso()) {
      this.kvDelete(pluginId, key);
      return null;
    }
    return JSON.parse(Buffer.from(row.value).toString("utf8"));
  }

  kvSet(pluginId: string, key: string, value: unknown, ttlSec?: number): { bytes: number; usage: number } {
    const buf = Buffer.from(JSON.stringify(value ?? null), "utf8");
    const usage = this.kvUsage(pluginId) - this.kvSize(pluginId, key) + buf.length;
    if (usage > KV_QUOTA_BYTES) throw Object.assign(new Error(`插件存储超过配额 ${KV_QUOTA_BYTES / 1024 / 1024}MB`), { code: -32006 });
    const expires = ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
    this.db
      .prepare("INSERT INTO plugin_kv(plugin_id, key, value, expires_at) VALUES(?, ?, ?, ?) ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
      .run(pluginId, key, buf, expires);
    return { bytes: buf.length, usage };
  }

  kvDelete(pluginId: string, key: string): void {
    this.db.prepare("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?").run(pluginId, key);
  }

  kvClear(pluginId: string): void {
    this.db.prepare("DELETE FROM plugin_kv WHERE plugin_id = ?").run(pluginId);
  }

  kvUsage(pluginId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(LENGTH(value)), 0) AS n FROM plugin_kv WHERE plugin_id = ?").get(pluginId) as { n: number };
    return Number(r.n);
  }

  private kvSize(pluginId: string, key: string): number {
    const r = this.db.prepare("SELECT LENGTH(value) AS n FROM plugin_kv WHERE plugin_id = ? AND key = ?").get(pluginId, key) as { n: number } | undefined;
    return r ? Number(r.n) : 0;
  }
}
