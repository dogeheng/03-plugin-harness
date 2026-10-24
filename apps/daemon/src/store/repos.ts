import { newId, nowIso, redact } from "@harness/shared";
import type { Db } from "./db.ts";

export interface SessionRow {
  id: string;
  title: string;
  workspace: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  created_at: string;
}

export interface AuditEvent {
  pluginId?: string | null;
  kind: string;
  permission?: string | null;
  target?: string | null;
  decision: "allow" | "deny" | "prompt" | "info" | "error";
  detail?: unknown;
}

export interface AuditRow {
  id: number;
  ts: string;
  plugin_id: string | null;
  kind: string;
  permission: string | null;
  target: string | null;
  decision: string;
  detail: string | null;
}

export class SessionRepo {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(title: string, workspace: string | null): SessionRow {
    const now = nowIso();
    const row: SessionRow = { id: newId("ses"), title, workspace, created_at: now, updated_at: now };
    this.db
      .prepare("INSERT INTO sessions(id, title, workspace, created_at, updated_at) VALUES(?, ?, ?, ?, ?)")
      .run(row.id, row.title, row.workspace, row.created_at, row.updated_at);
    return row;
  }

  get(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  list(limit = 50): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as SessionRow[];
  }

  rename(id: string, title: string): void {
    this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, nowIso(), id);
  }

  touch(id: string): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  appendMessage(sessionId: string, role: string, content: unknown): MessageRow {
    const seqRow = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE session_id = ?").get(sessionId) as { s: number };
    const row: MessageRow = {
      id: newId("msg"),
      session_id: sessionId,
      seq: Number(seqRow.s) + 1,
      role,
      content: JSON.stringify(content),
      created_at: nowIso(),
    };
    this.db
      .prepare("INSERT INTO messages(id, session_id, seq, role, content, created_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(row.id, row.session_id, row.seq, row.role, row.content, row.created_at);
    this.touch(sessionId);
    return row;
  }

  messages(sessionId: string): MessageRow[] {
    return this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY seq").all(sessionId) as unknown as MessageRow[];
  }
}

export interface ToolCallRecord {
  id: string;
  sessionId: string | null;
  toolName: string;
  pluginId: string | null;
  input: unknown;
  output?: unknown;
  error?: string | null;
  status: "ok" | "error" | "denied" | "blocked";
  startedAt: string;
  durationMs: number;
}

export class ToolCallRepo {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  record(r: ToolCallRecord): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO tool_calls(id, session_id, tool_name, plugin_id, input, output, error, status, started_at, duration_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        r.id,
        r.sessionId,
        r.toolName,
        r.pluginId,
        redact(JSON.stringify(r.input ?? null)),
        r.output === undefined ? null : redact(JSON.stringify(r.output)).slice(0, 200_000),
        r.error ? redact(r.error) : null,
        r.status,
        r.startedAt,
        r.durationMs,
      );
  }
  recent(pluginId: string | null, limit = 50): unknown[] {
    if (pluginId) return this.db.prepare("SELECT * FROM tool_calls WHERE plugin_id = ? ORDER BY started_at DESC LIMIT ?").all(pluginId, limit);
    return this.db.prepare("SELECT * FROM tool_calls ORDER BY started_at DESC LIMIT ?").all(limit);
  }
  summariesForSession(sessionId: string): unknown[] {
    return this.db.prepare("SELECT id, plugin_id, status, error, duration_ms FROM tool_calls WHERE session_id = ? ORDER BY started_at").all(sessionId);
  }
}

export class AuditRepo {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  write(e: AuditEvent): AuditRow {
    const ts = nowIso();
    const detail = e.detail === undefined ? null : redact(JSON.stringify(e.detail));
    const res = this.db
      .prepare("INSERT INTO audit_events(ts, plugin_id, kind, permission, target, decision, detail) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(ts, e.pluginId ?? null, e.kind, e.permission ?? null, e.target ? redact(e.target) : null, e.decision, detail);
    return {
      id: Number(res.lastInsertRowid),
      ts,
      plugin_id: e.pluginId ?? null,
      kind: e.kind,
      permission: e.permission ?? null,
      target: e.target ?? null,
      decision: e.decision,
      detail,
    };
  }
  list(opts: { pluginId?: string; limit?: number; decision?: string } = {}): AuditRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.pluginId) {
      where.push("plugin_id = ?");
      args.push(opts.pluginId);
    }
    if (opts.decision) {
      where.push("decision = ?");
      args.push(opts.decision);
    }
    const sql = `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    args.push(opts.limit ?? 100);
    return this.db.prepare(sql).all(...args) as unknown as AuditRow[];
  }
}
