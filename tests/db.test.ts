import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, openDb } from "../src/db.js";

describe("openDb", () => {
  it("applies all migrations to an in-memory database", () => {
    const db = openDb(":memory:", new URL("../src/migrations", import.meta.url).pathname);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => (r as { name: string }).name);
    for (const t of ["hosts", "jobs", "runs", "run_files", "partials", "partial_ranges", "ledger", "ledger_units", "remote_observations", "settings", "users", "sessions", "activity"]) {
      expect(tables).toContain(t);
    }
  });

  it("enforces foreign keys", () => {
    const db = openDb(":memory:", new URL("../src/migrations", import.meta.url).pathname);
    expect(() => db.prepare("INSERT INTO runs (job_id, trigger, state) VALUES (999, 'manual', 'queued')").run()).toThrow();
  });
});

describe("migrate", () => {
  const mk = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-mig-"));
    for (const [n, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), sql);
    return dir;
  };
  const mem = () => new Database(":memory:");

  it("applies migrations in numeric order (9 before 10)", () => {
    const dir = mk({ "10_b.sql": "CREATE TABLE b (x);", "9_a.sql": "CREATE TABLE a (x);" });
    expect(migrate(mem(), dir)).toEqual(["9_a.sql", "10_b.sql"]);
  });

  it("throws when the directory has no migrations", () => {
    expect(() => migrate(mem(), mk({ "readme.txt": "x" }))).toThrow(/no .sql migrations/);
  });

  it("refuses an unapplied migration numbered below the highest applied one", () => {
    const db = mem();
    migrate(db, mk({ "002_b.sql": "CREATE TABLE b (x);" }));
    expect(() => migrate(db, mk({ "001_a.sql": "CREATE TABLE a (x);", "002_b.sql": "CREATE TABLE b (x);" }))).toThrow(/out of order/);
  });

  it("is idempotent and keeps foreign keys on", () => {
    const db = openDb(":memory:", new URL("../src/migrations", import.meta.url).pathname);
    expect(migrate(db, new URL("../src/migrations", import.meta.url).pathname)).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });
});
