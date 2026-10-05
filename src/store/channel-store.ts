import type { DB } from "../db.js";
import { ConfigUnreadableError } from "./errors.js";
import type { Crypto } from "./host-store.js";

export const CHANNEL_KINDS = ["ntfy", "discord", "telegram", "pushover", "webhook"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export type ChannelPublic = { id: number; name: string; kind: ChannelKind; enabled: boolean };
export type ChannelConfig = ChannelPublic & { config: Record<string, string> };
export type ChannelInput = { name: string; kind: ChannelKind; config: Record<string, string>; enabled?: boolean };

type ChannelSql = { id: number; name: string; kind: ChannelKind; config_enc: Buffer; enabled: number };

const toPublic = (r: ChannelSql): ChannelPublic => ({ id: r.id, name: r.name, kind: r.kind, enabled: r.enabled === 1 });

export class SqliteChannelStore {
  constructor(private readonly db: DB, private readonly crypto: Crypto) {}

  private row(id: number): ChannelSql | undefined {
    return this.db.prepare("SELECT * FROM notify_channels WHERE id = ?").get(id) as ChannelSql | undefined;
  }

  create(input: ChannelInput): number {
    const now = Date.now();
    const res = this.db.prepare("INSERT INTO notify_channels (name, kind, config_enc, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.name, input.kind, this.crypto.encrypt(JSON.stringify(input.config)), input.enabled === false ? 0 : 1, now, now);
    return Number(res.lastInsertRowid);
  }

  /** The kind never changes. `config`, when given, replaces the whole stored config. */
  update(id: number, patch: { name?: string; enabled?: boolean; config?: Record<string, string> }): void {
    const cur = this.row(id);
    if (!cur) throw new Error(`channel ${id} not found`);
    const enc = patch.config ? this.crypto.encrypt(JSON.stringify(patch.config)) : cur.config_enc;
    const enabled = patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0;
    this.db.prepare("UPDATE notify_channels SET name = ?, config_enc = ?, enabled = ?, updated_at = ? WHERE id = ?")
      .run(patch.name ?? cur.name, enc, enabled, Date.now(), id);
  }

  /** Removes the channel and its id from every job's list. Returns the names of the jobs that referenced it. */
  delete(id: number): string[] {
    const names = this.usedBy(id);
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT job_id, notify_channel_ids FROM job_integrations").all() as { job_id: number; notify_channel_ids: string }[];
      for (const r of rows) {
        const ids = parseIds(r.notify_channel_ids);
        if (ids.includes(id)) {
          this.db.prepare("UPDATE job_integrations SET notify_channel_ids = ? WHERE job_id = ?").run(JSON.stringify(ids.filter((x) => x !== id)), r.job_id);
        }
      }
      this.db.prepare("DELETE FROM notify_channels WHERE id = ?").run(id);
    })();
    return names;
  }

  usedBy(id: number): string[] {
    const rows = this.db.prepare(
      "SELECT j.name, i.notify_channel_ids AS ids FROM job_integrations i JOIN jobs j ON j.id = i.job_id ORDER BY j.name",
    ).all() as { name: string; ids: string }[];
    return rows.filter((r) => parseIds(r.ids).includes(id)).map((r) => r.name);
  }

  getPublic(id: number): ChannelPublic | undefined {
    const r = this.row(id);
    return r && toPublic(r);
  }

  listPublic(): ChannelPublic[] {
    return (this.db.prepare("SELECT * FROM notify_channels ORDER BY name").all() as ChannelSql[]).map(toPublic);
  }

  /** Decrypted. In-memory use only; throws ConfigUnreadableError when it cannot be decrypted or parsed (APP_SECRET changed). */
  getConfig(id: number): ChannelConfig {
    const r = this.row(id);
    if (!r) throw new Error(`channel ${id} not found`);
    try {
      return { ...toPublic(r), config: JSON.parse(this.crypto.decrypt(r.config_enc)) as Record<string, string> };
    } catch (err) {
      throw new ConfigUnreadableError("channel", id, err);
    }
  }
}

export function parseIds(raw: string): number[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}
