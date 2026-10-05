import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { buildLogger } from "../src/logger.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("createApp boot", () => {
  it("starts with default settings and a warning when stored settings are corrupt", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "harvest-app-"));
    const config = loadConfig({ CONFIG_DIR: dir, APP_SECRET: "x".repeat(32), BROWSE_ROOTS: dir });
    const db = openDb(config.dbPath);
    db.prepare("INSERT INTO settings (key, value) VALUES ('bwlimit_global_bps', '{not json')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('retention', '[]')").run();
    db.close();
    const logger = buildLogger("silent", false);
    const warn = vi.spyOn(logger, "warn");
    const app = await createApp(config, logger);
    expect(warn.mock.calls.some((c) => String(c[1]).includes("Stored settings are invalid"))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[1]).includes("Stored bandwidth settings are invalid"))).toBe(true);
    await app.stop();
  });
});
