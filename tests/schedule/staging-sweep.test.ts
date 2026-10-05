import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { TransferEngine } from "../../src/engine/types.js";
import { createSlots } from "../../src/run/connection-slots.js";
import { runMaintenance, type MaintenanceDeps } from "../../src/schedule/maintenance.js";
import { setup } from "../store/helpers.js";

const DAY = 86_400_000;
const NOW = Date.now();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function harness(overrides: Partial<MaintenanceDeps> = {}) {
  const base = setup();
  const local = mkdtempSync(path.join(tmpdir(), "sweep-"));
  dirs.push(local);
  base.stores.jobs.update(base.jobId, { localPath: local });
  const engine = { id: "rclone", open: async () => { throw new Error("unused"); } } as unknown as TransferEngine;
  const deps: MaintenanceDeps = {
    stores: base.stores, engine, logger: pino({ level: "silent" }), slotsFor: (h) => createSlots(h.maxConnections),
    purgeSessions: () => 0, stalePartials: (ts) => base.stores.partials.listOlderThan(ts), ...overrides,
  };
  const root = path.join(local, ".harvest-staging", String(base.jobId));
  mkdirSync(path.join(root, "Pack"), { recursive: true });
  const put = (rel: string, ageDays: number, where = root): string => {
    const p = path.join(where, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, "x");
    const t = (NOW - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
    return p;
  };
  return { ...base, deps, local, root, put };
}

describe("staging sweep of files no partial owns", () => {
  it("removes old orphans (aborted extraction output, archive left after a crash) and keeps recent ones", async () => {
    const h = harness();
    const oldExtra = h.put("Pack/ep.mkv", 10);
    const oldArchive = h.put("Pack/a.zip", 8);
    const fresh = h.put("Pack/new.mkv", 1);
    const res = await runMaintenance(h.deps, NOW);
    expect(res.stagingDiscarded).toBe(2);
    expect([existsSync(oldExtra), existsSync(oldArchive), existsSync(fresh)]).toEqual([false, false, true]);
  });

  it("never removes a file that a partial row owns, however old", async () => {
    const h = harness();
    const owned = h.put("Pack/b.zip", 30);
    h.stores.partials.create({ jobId: h.jobId, remotePath: "Pack/b.zip", remoteSize: 1, remoteMtimeMs: 1, stagingPath: owned }, []);
    h.db.prepare("UPDATE partials SET updated_at = ?").run(NOW);
    await runMaintenance(h.deps, NOW);
    expect(existsSync(owned)).toBe(true);
  });

  it("skips a job with a running run (busyJobs) and one with a non-terminal run row", async () => {
    const busy = harness({ busyJobs: () => new Set([1]) });
    const p = busy.put("Pack/ep.mkv", 30);
    await runMaintenance(busy.deps, NOW);
    expect(existsSync(p)).toBe(true);
    const running = harness();
    const q = running.put("Pack/ep.mkv", 30);
    running.stores.runs.create(running.jobId, "manual", false);
    await runMaintenance(running.deps, NOW);
    expect(existsSync(q)).toBe(true);
  });

  it("never touches anything outside .harvest-staging, nor follows a symlinked directory out of it", async () => {
    const h = harness();
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
    dirs.push(outside);
    const victim = h.put("keep.txt", 90, outside);
    const sibling = h.put("movie.mkv", 90, h.local);
    symlinkSync(outside, path.join(h.root, "Pack", "link"));
    await runMaintenance(h.deps, NOW);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(sibling)).toBe(true);
  });

  it("does not sweep when .harvest-staging itself is a symlink", async () => {
    const h = harness();
    const target = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
    dirs.push(target);
    const victim = h.put(`${h.jobId}/old.bin`, 90, target);
    rmSync(path.join(h.local, ".harvest-staging"), { recursive: true });
    symlinkSync(target, path.join(h.local, ".harvest-staging"));
    await runMaintenance(h.deps, NOW);
    expect(existsSync(victim)).toBe(true);
  });

  it("prunes directories left empty by the sweep but keeps the staging root", async () => {
    const h = harness();
    h.put("Pack/deep/ep.mkv", 20);
    await runMaintenance(h.deps, NOW);
    expect(existsSync(path.join(h.root, "Pack"))).toBe(false);
    expect(existsSync(h.root)).toBe(true);
  });
});
