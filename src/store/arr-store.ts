import type { DB } from "../db.js";
import { ConfigUnreadableError } from "./errors.js";
import type { Crypto } from "./host-store.js";

export type ArrKind = "sonarr" | "radarr";
export type ArrPublic = { id: number; name: string; kind: ArrKind; url: string; hasKey: boolean };
export type ArrConfig = { id: number; name: string; kind: ArrKind; url: string; apiKey: string };
export type ArrInput = { name: string; kind: ArrKind; url: string; apiKey: string };

type ArrSql = { id: number; name: string; kind: ArrKind; url: string; api_key_enc: Buffer };

const toPublic = (r: ArrSql): ArrPublic => ({ id: r.id, name: r.name, kind: r.kind, url: r.url, hasKey: r.api_key_enc.length > 0 });

export class SqliteArrStore {
  constructor(private readonly db: DB, private readonly crypto: Crypto) {}

  private row(id: number): ArrSql | undefined {
    return this.db.prepare("SELECT * FROM arr_targets WHERE id = ?").get(id) as ArrSql | undefined;
  }

  create(input: ArrInput): number {
    const now = Date.now();
    const res = this.db.prepare("INSERT INTO arr_targets (name, kind, url, api_key_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.name, input.kind, input.url, this.crypto.encrypt(input.apiKey), now, now);
    return Number(res.lastInsertRowid);
  }

  /** The stored key is kept unless `apiKey` is a non-empty string. */
  update(id: number, patch: Partial<ArrInput>): void {
    const cur = this.row(id);
    if (!cur) throw new Error(`arr target ${id} not found`);
    const enc = patch.apiKey ? this.crypto.encrypt(patch.apiKey) : cur.api_key_enc;
    this.db.prepare("UPDATE arr_targets SET name = ?, kind = ?, url = ?, api_key_enc = ?, updated_at = ? WHERE id = ?")
      .run(patch.name ?? cur.name, patch.kind ?? cur.kind, patch.url ?? cur.url, enc, Date.now(), id);
  }

  /** Jobs that use the target keep their row but lose the reference (FK SET NULL). Returns the names of the affected jobs. */
  delete(id: number): string[] {
    const names = this.usedBy(id);
    this.db.prepare("DELETE FROM arr_targets WHERE id = ?").run(id);
    return names;
  }

  usedBy(id: number): string[] {
    const rows = this.db.prepare(
      "SELECT j.name FROM job_integrations i JOIN jobs j ON j.id = i.job_id WHERE i.arr_target_id = ? ORDER BY j.name",
    ).all(id) as { name: string }[];
    return rows.map((r) => r.name);
  }

  getPublic(id: number): ArrPublic | undefined {
    const r = this.row(id);
    return r && toPublic(r);
  }

  listPublic(): ArrPublic[] {
    return (this.db.prepare("SELECT * FROM arr_targets ORDER BY name").all() as ArrSql[]).map(toPublic);
  }

  /** Decrypted. In-memory use only; throws ConfigUnreadableError when the key cannot be decrypted (APP_SECRET changed). */
  getConfig(id: number): ArrConfig {
    const r = this.row(id);
    if (!r) throw new Error(`arr target ${id} not found`);
    try {
      return { id: r.id, name: r.name, kind: r.kind, url: r.url, apiKey: this.crypto.decrypt(r.api_key_enc) };
    } catch (err) {
      throw new ConfigUnreadableError("*arr target", id, err);
    }
  }
}
