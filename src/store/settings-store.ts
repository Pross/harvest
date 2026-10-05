import type { z } from "zod";
import type { DB } from "../db.js";

export class SqliteSettingsStore {
  constructor(private readonly db: DB) {}

  get(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return r?.value;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  /** Parse and validate the stored JSON. Returns undefined when the key is absent; throws when present but invalid. */
  getJson<T>(key: string, schema: z.ZodType<T>): T | undefined {
    const raw = this.get(key);
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`setting "${key}" is not valid JSON: ${(err as Error).message}`);
    }
    const res = schema.safeParse(parsed);
    if (!res.success) throw new Error(`setting "${key}" failed validation: ${res.error.message}`);
    return res.data;
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }
}
