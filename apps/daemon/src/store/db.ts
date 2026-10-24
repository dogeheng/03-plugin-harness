import { DatabaseSync } from "node:sqlite";

/**
 * Ordered schema migrations. Each entry is applied once inside a transaction
 * and recorded in `meta.schema_version`. Append new migrations; never edit old ones.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX messages_session ON messages(session_id, seq);
  CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT NOT NULL, plugin_id TEXT,
    input TEXT, output TEXT, error TEXT, status TEXT NOT NULL,
    started_at TEXT NOT NULL, duration_ms INTEGER
  );
  CREATE INDEX tool_calls_session ON tool_calls(session_id, started_at);
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, plugin_id TEXT, kind TEXT NOT NULL,
    permission TEXT, target TEXT, decision TEXT NOT NULL, detail TEXT
  );
  CREATE INDEX audit_plugin ON audit_events(plugin_id, ts);
  CREATE TABLE plugins (
    id TEXT PRIMARY KEY, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    previous_version TEXT, quarantined_reason TEXT, dev_path TEXT
  );
  CREATE TABLE plugin_versions (
    plugin_id TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, manifest TEXT NOT NULL,
    source TEXT NOT NULL, verified TEXT NOT NULL DEFAULT 'unverified', installed_at TEXT NOT NULL,
    PRIMARY KEY (plugin_id, version)
  );
  CREATE TABLE grants (
    id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, permission TEXT NOT NULL, scope TEXT,
    version_range TEXT, workspace TEXT, source TEXT NOT NULL,
    granted_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT
  );
  CREATE INDEX grants_plugin ON grants(plugin_id);
  CREATE TABLE plugin_settings (plugin_id TEXT PRIMARY KEY, values_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE plugin_kv (
    plugin_id TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, expires_at TEXT,
    PRIMARY KEY (plugin_id, key)
  );
  `,
  `
  CREATE TABLE web_sessions (token_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  `,
];

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  let version = row ? Number(row.value) : 0;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      const sql = i === 0 ? (MIGRATIONS[0] ?? "").replace("CREATE TABLE meta", "CREATE TABLE IF NOT EXISTS meta") : (MIGRATIONS[i] ?? "");
      db.exec(sql);
      db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(i + 1));
      db.exec("COMMIT");
      version = i + 1;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return version;
}

export const SCHEMA_VERSION = MIGRATIONS.length;
