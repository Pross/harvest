import type { DB } from "../db.js";
import { randomToken, sha256Hex } from "../crypto.js";

export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
/** Refresh the expiry (and cookie) only when at least this much of the TTL has elapsed. */
export const REFRESH_AFTER_MS = 10 * 60 * 1000;

export type Session = {
  /** The cookie value (never stored; the DB keeps sha256 of it). */
  id: string;
  userId: number;
  username: string;
  csrfToken: string;
  expiresAt: number;
  /** True when the expiry was just extended and the cookie must be re-sent. */
  refreshed: boolean;
};

type Row = { user_id: number; username: string; csrf_token: string; expires_at: number };

/** Server-side sessions in SQLite. The session id is a random token; only its sha256 is stored. */
export class SessionStore {
  constructor(private readonly db: DB, private readonly now: () => number = Date.now) {}

  create(userId: number): Session {
    const id = randomToken();
    const csrfToken = randomToken();
    const t = this.now();
    const expiresAt = t + SESSION_TTL_MS;
    this.db.prepare("INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256Hex(id), userId, csrfToken, t, expiresAt);
    const u = this.db.prepare("SELECT username FROM users WHERE id = ?").get(userId) as { username: string } | undefined;
    return { id, userId, username: u?.username ?? "", csrfToken, expiresAt, refreshed: false };
  }

  /** Valid session or undefined; expired sessions are deleted. Slides the expiry forward. */
  get(id: string): Session | undefined {
    const key = sha256Hex(id);
    const r = this.db.prepare(
      `SELECT s.user_id, u.username, s.csrf_token, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    ).get(key) as Row | undefined;
    if (!r) return undefined;
    const t = this.now();
    if (r.expires_at <= t) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(key);
      return undefined;
    }
    const stale = SESSION_TTL_MS - (r.expires_at - t) >= REFRESH_AFTER_MS;
    const expiresAt = stale ? t + SESSION_TTL_MS : r.expires_at;
    if (stale) this.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(expiresAt, key);
    return { id, userId: r.user_id, username: r.username, csrfToken: r.csrf_token, expiresAt, refreshed: stale };
  }

  /** True while the session row exists and has not expired. Never slides the expiry (used by long-lived SSE streams). */
  exists(id: string): boolean {
    const r = this.db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(sha256Hex(id)) as { expires_at: number } | undefined;
    return !!r && r.expires_at > this.now();
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256Hex(id));
  }

  purgeExpired(): number {
    return this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(this.now()).changes;
  }
}

export type UserRow = { id: number; username: string; passwordHash: string };

export function countUsers(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function findUser(db: DB, username: string): UserRow | undefined {
  const r = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(username) as
    { id: number; username: string; password_hash: string } | undefined;
  return r && { id: r.id, username: r.username, passwordHash: r.password_hash };
}

/** Inserts the user only when none exists (single-user app). Returns false when a user already exists. */
export function createFirstUser(db: DB, username: string, passwordHash: string, now = Date.now()): boolean {
  return db.transaction(() => {
    if (countUsers(db) > 0) return false;
    db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(username, passwordHash, now);
    return true;
  })();
}
