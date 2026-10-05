import { createHash, randomBytes } from "node:crypto";
import { constantTimeEqual } from "../crypto.js";
import type { DB } from "../db.js";

export type ApiToken = { id: number; jobId: number; name: string; createdAt: number; lastUsedAt: number | null };
type Row = { id: number; job_id: number; name: string; created_at: number; last_used_at: number | null; token_hash: string };

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const toToken = (r: Row): ApiToken => ({ id: r.id, jobId: r.job_id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at });

/** Job-scoped webhook tokens. Plaintext is returned once by `create` and never stored. */
export class SqliteTokenStore {
  constructor(private readonly db: DB) {}

  /** 32 random bytes, base64url. The returned `token` is the only copy. */
  create(jobId: number, name: string, now: number = Date.now()): { token: string; record: ApiToken } {
    const token = randomBytes(32).toString("base64url");
    const info = this.db
      .prepare("INSERT INTO api_tokens (job_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(jobId, name, hashToken(token), now);
    return { token, record: { id: Number(info.lastInsertRowid), jobId, name, createdAt: now, lastUsedAt: null } };
  }

  listForJob(jobId: number): ApiToken[] {
    const rows = this.db.prepare("SELECT * FROM api_tokens WHERE job_id = ? ORDER BY id").all(jobId) as Row[];
    return rows.map(toToken);
  }

  /** True when a token of this job was removed. The job id guards against revoking another job's token. */
  revoke(jobId: number, tokenId: number): boolean {
    return this.db.prepare("DELETE FROM api_tokens WHERE id = ? AND job_id = ?").run(tokenId, jobId).changes > 0;
  }

  /** Looks a presented token up by hash and re-checks the hash with a constant-time compare. */
  verify(token: string): ApiToken | undefined {
    const hash = hashToken(token);
    const row = this.db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(hash) as Row | undefined;
    return row && constantTimeEqual(row.token_hash, hash) ? toToken(row) : undefined;
  }

  touch(tokenId: number, now: number = Date.now()): void {
    this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, tokenId);
  }
}
