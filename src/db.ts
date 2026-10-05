import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Prod: dist/migrations (copied in the Docker build). Dev/test via tsx or vitest: src/migrations. */
export const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/** Open (creating parent dirs) a WAL-mode database with foreign keys on, then apply migrations. */
export function openDb(file: string, migrationsDir: string = MIGRATIONS_DIR): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db, migrationsDir);
  return db;
}

const migrationNumber = (name: string): number => Number(/^\d+/.exec(name)![0]);

/**
 * Apply `NNN_name.sql` files in numeric order, once each, each in its own transaction. Throws on any failure, when the
 * directory holds no migrations, and when an unapplied migration is numbered below the highest applied one.
 */
export function migrate(db: DB, dir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name));
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort((a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b));
  if (files.length === 0) throw new Error(`no .sql migrations found in ${dir}`);
  const highest = Math.max(-1, ...[...done].map(migrationNumber));
  const late = files.find((f) => !done.has(f) && migrationNumber(f) < highest);
  if (late) throw new Error(`migration ${late} is numbered below the highest applied migration (${highest}); refusing to apply out of order`);
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, Date.now());
    })();
    applied.push(f);
  }
  return applied;
}
