import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

/** Every table a dry run must leave alone (run_files, runs and activity are the run's own record). */
const TABLES = ["remote_observations", "ledger", "ledger_units", "partials", "partial_ranges", "jobs", "hosts", "settings"];

describe("dry run side effects", () => {
  it("changes no observation, ledger, partial, job or setting row and no remote or local file", async () => {
    const h = makeHarness({ job: { afterSync: "delete" } });
    h.session.set("Show/e1.bin", makeData(5000, 1));
    h.session.set("Show/e2.bin", makeData(5000, 2));
    await h.exec(); // records first sightings
    h.clock.t += 5000;
    h.session.set("late.bin", makeData(4000, 3)); // never seen before: a real run would start its settle clock
    const snap = (): string => JSON.stringify(TABLES.map((t) => h.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = snap();
    const remoteBefore = [...h.session.files.keys()];
    const followups = h.followups.length;

    const r = await h.exec({ dryRun: true });

    expect(r.state).toBe("succeeded");
    expect(snap()).toBe(before);
    expect([...h.session.files.keys()]).toEqual(remoteBefore);
    expect(h.session.removed).toEqual([]);
    expect(h.session.ranged.bytes).toBe(0);
    expect(h.followups.length).toBe(followups);
    expect(existsSync(path.join(h.local, "Show"))).toBe(false);
    expect(existsSync(path.join(h.local, ".harvest-staging"))).toBe(false);
  });

  it("records planned and would-skip rows for the run only", async () => {
    const h = makeHarness({ job: { afterSync: "delete" } });
    h.session.set("Show/e1.bin", makeData(5000, 1));
    await h.exec();
    h.clock.t += 5000;
    h.session.set("late.bin", makeData(4000, 3));
    const r = await h.exec({ dryRun: true });
    const rows = h.stores.runs.filesForRun(r.runId);
    expect(rows.filter((f) => f.state === "planned").map((f) => [f.remotePath, f.size, f.unitKey])).toEqual([["Show/e1.bin", 5000, "Show"]]);
    expect(rows.filter((f) => f.state === "would_skip").map((f) => [f.remotePath, f.error])).toEqual([["late.bin", "first_sighting"]]);
    expect(r.row).toMatchObject({ filesPlanned: 1, bytesTotal: 5000, dryRun: true });
  });

  it("marks units the free-space check would drop as would-skip", async () => {
    const h = makeHarness({ freeBytes: 100 });
    h.session.set("big.bin", makeData(5000, 1));
    await h.exec();
    h.clock.t += 5000;
    const r = await h.exec({ dryRun: true });
    expect(r.state).toBe("skipped_space");
    expect(h.stores.runs.filesForRun(r.runId).map((f) => [f.state, f.error])).toEqual([["would_skip", "no_space"]]);
  });
});
