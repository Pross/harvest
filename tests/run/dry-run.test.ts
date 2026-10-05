import { describe, expect, it } from "vitest";
import { DRY_ROW_CAP, DRY_SUMMARY_CATEGORY, recordDryRun, type DrySummary } from "../../src/run/dry-run.js";
import type { PlannedUnit, SkippedEntry } from "../../src/planner/types.js";
import { dryRunView } from "../../src/web/dryrun-view.js";
import { setup } from "../store/helpers.js";

const unit = (n: number): PlannedUnit => {
  const files = Array.from({ length: n }, (_, i) => ({ remotePath: `u/f${i}`, size: 10, mtimeMs: 1 }));
  return { key: "u", files, totalBytes: n * 10, existing: false };
};
const skips = (n: number): SkippedEntry[] => Array.from({ length: n }, (_, i) => ({ remotePath: `s${i}`, reason: "already_synced" as const }));

describe("recordDryRun", () => {
  it("caps rows but stores and shows the true counts", () => {
    const { stores, jobId } = setup();
    const runId = stores.runs.create(jobId, "manual", true);
    const total = DRY_ROW_CAP + 7;
    recordDryRun(stores, runId, skips(total), [unit(total)], []);
    const files = stores.runs.filesForRun(runId);
    expect(files.filter((f) => f.state === "planned")).toHaveLength(DRY_ROW_CAP);
    expect(files.filter((f) => f.state === "would_skip")).toHaveLength(DRY_ROW_CAP);
    expect(stores.runs.get(runId)).toMatchObject({ filesPlanned: total, bytesTotal: total * 10 });
    const summary = stores.activity.list({ runId, category: DRY_SUMMARY_CATEGORY, limit: 1 })[0]!.meta as DrySummary;
    const view = dryRunView(files, undefined, summary);
    expect(view.plannedCount).toBe(total);
    expect(view.skips[0]).toMatchObject({ reason: "already_synced", count: total });
    expect(view.hiddenPlanned).toBeGreaterThan(0);
  });

  it("writes everything in one transaction", () => {
    const { stores, jobId } = setup();
    const runId = stores.runs.create(jobId, "manual", true);
    const bad = { ...unit(2), files: [{ remotePath: "a", size: 1, mtimeMs: 1 }, null as never] };
    expect(() => recordDryRun(stores, runId, skips(2), [bad], [])).toThrow();
    expect(stores.runs.filesForRun(runId)).toEqual([]);
    expect(stores.activity.list({ runId, limit: 5 })).toEqual([]);
  });
});
