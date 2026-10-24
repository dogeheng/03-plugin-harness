import { createHash, timingSafeEqual } from "node:crypto";
import { newToken } from "@harness/shared";
import type { Db } from "../store/db.ts";

export const SESSION_COOKIE = "harness_session";
const LOGIN_CODE_TTL_MS = 120_000;
const WEB_SESSION_TTL_MS = 7 * 24 * 3600_000;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Local API authentication (report 3.9):
 * - CLI: bearer token from daemon.json (0600) over a 0600 Unix socket.
 * - Browser: one-time login code minted over the Unix socket, exchanged for an
 *   HttpOnly SameSite=Strict cookie. Only the hash of the cookie is stored.
 * - TCP requests must carry a loopback Host header (DNS-rebinding defense) and,
 *   when present, a same-origin Origin header (CSRF defense).
 */
export class AuthService {
  readonly token: string;
  private readonly db: Db;
  private readonly codes = new Map<string, number>();
  private port = 0;

  constructor(db: Db, token = newToken()) {
    this.db = db;
    this.token = token;
  }

  setPort(port: number): void {
    this.port = port;
  }

  allowedHosts(): string[] {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
  }

  allowedOrigins(): string[] {
    return this.allowedHosts().map((h) => `http://${h}`);
  }

  isAllowedHost(host: string | undefined | null): boolean {
    return !!host && this.allowedHosts().includes(host.toLowerCase());
  }

  isAllowedOrigin(origin: string | undefined | null): boolean {
    return origin === undefined || origin === null || this.allowedOrigins().includes(origin);
  }

  checkBearer(header: string | undefined | null): boolean {
    if (!header?.startsWith("Bearer ")) return false;
    return safeEqual(header.slice(7), this.token);
  }

  mintLoginCode(): string {
    for (const [code, expires] of this.codes) if (expires < Date.now()) this.codes.delete(code);
    const code = newToken(24);
    this.codes.set(code, Date.now() + LOGIN_CODE_TTL_MS);
    return code;
  }

  /** Single use: a code is deleted on first redemption, valid or not. */
  redeemLoginCode(code: string): string | null {
    const exp = this.codes.get(code);
    this.codes.delete(code);
    if (!exp || exp < Date.now()) return null;
    const session = newToken(32);
    const now = Date.now();
    this.db
      .prepare("INSERT INTO web_sessions(token_hash, created_at, expires_at) VALUES(?, ?, ?)")
      .run(sha256(session), new Date(now).toISOString(), new Date(now + WEB_SESSION_TTL_MS).toISOString());
    return session;
  }

  checkSessionCookie(cookieHeader: string | undefined | null): boolean {
    const value = parseCookie(cookieHeader ?? "")[SESSION_COOKIE];
    if (!value) return false;
    const row = this.db.prepare("SELECT expires_at FROM web_sessions WHERE token_hash = ?").get(sha256(value)) as { expires_at: string } | undefined;
    return !!row && row.expires_at > new Date().toISOString();
  }

  revokeAllWebSessions(): void {
    this.db.exec("DELETE FROM web_sessions");
  }

  cookieHeader(session: string): string {
    return `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1000)}`;
  }
}

export function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // Malformed client cookies must not throw out of a WebSocket upgrade handler.
      }
    }
  }
  return out;
}
