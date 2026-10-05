import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSpaceReservations, fitToSpace } from "../../src/run/space.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

const unit = (key: string, totalBytes: number) => ({ key, files: [], totalBytes, existing: false });

describe("space reservations", () => {
  it("sums other runs only and releases", () => {
    const r = createSpaceReservations();
    r.set(1, 100);
    r.set(2, 50);
    expect(r.reservedByOthers(1)).toBe(50);
    expect(r.reservedByOthers(3)).toBe(150);
    r.set(1, 10);
    expect(r.reservedByOthers(2)).toBe(10);
    r.release(1);
    expect(r.reservedByOthers(2)).toBe(0);
  });

  it("fitToSpace trims whole units against free space minus others and reserves the kept bytes", async () => {
    const reservations = createSpaceReservations();
    reservations.set(9, 300);
    const fit = await fitToSpace({
      units: [unit("big", 500), unit("small", 100), unit("mid", 200)], localPath: "/definitely/not/there", minFreeBytes: 50, runId: 1,
      reservations, statfs: async () => ({ bavail: 100, bsize: 10 }),
    });
    expect(fit.kept.map((u) => u.key)).toEqual(["small", "mid"]);
    expect(fit.dropped.map((u) => u.key)).toEqual(["big"]);
    expect(reservations.reservedByOthers(2)).toBe(300 + 300);
  });

  it("statfs is asked about the nearest existing ancestor of a missing target", async () => {
    const asked: string[] = [];
    await fitToSpace({ units: [], localPath: "/tmp/harvest-missing-xyz/deeper", minFreeBytes: null, runId: 1, reservations: createSpaceReservations(), statfs: async (p) => (asked.push(p), { bavail: 1, bsize: 1 }) });
    expect(asked).toEqual([path.resolve("/tmp")]);
  });
});

describe("executor free-space guard", () => {
  it("trims by whole unit, smallest first, and ends partial with a warning", async () => {
    const h = makeHarness({ freeBytes: 12_000 });
    h.session.set("Big/a.bin", makeData(10_000, 1));
    h.session.set("Big/b.bin", makeData(10_000, 2));
    h.session.set("Small/a.bin", makeData(5000, 3));
    const r = await h.settled();
    expect(r.state).toBe("partial");
    expect(existsSync(path.join(h.local, "Small/a.bin"))).toBe(true);
    expect(existsSync(path.join(h.local, "Big"))).toBe(false);
    expect(r.row.filesPlanned).toBe(1);
    expect(h.activity().some((a) => a.category === "space" && a.summary.includes("Big"))).toBe(true);
  });

  it("ends skipped_space when nothing fits and downloads nothing", async () => {
    const h = makeHarness({ freeBytes: 100 });
    h.session.set("a.bin", makeData(5000, 1));
    const r = await h.settled();
    expect(r.state).toBe("skipped_space");
    expect(h.session.ranged.bytes).toBe(0);
    expect(r.row.finishedAt).not.toBeNull();
    expect(h.activity().some((a) => a.severity === "warn" && a.summary.includes("skipped_space"))).toBe(true);
  });

  it("honors min_free_bytes", async () => {
    const h = makeHarness({ freeBytes: 6000, job: { minFreeBytes: 2000 } });
    h.session.set("a.bin", makeData(5000, 1));
    expect((await h.settled()).state).toBe("skipped_space");
  });

  it("counts reservations of other runs", async () => {
    const h = makeHarness({ freeBytes: 20_000 });
    h.deps.reservations.set(777, 18_000);
    h.session.set("a.bin", makeData(5000, 1));
    expect((await h.settled()).state).toBe("skipped_space");
    h.deps.reservations.release(777);
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
  });

  it("a unit that exactly fits is kept", async () => {
    const h = makeHarness({ freeBytes: 5000 });
    h.session.set("a.bin", makeData(5000, 1));
    expect((await h.settled()).state).toBe("succeeded");
  });

  it("releases its reservation after success and after failure", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(5000, 1));
    await h.settled();
    expect(h.deps.reservations.reservedByOthers(-1)).toBe(0);
    const f = makeHarness({ job: { retries: 0 } });
    f.session.set("a.bin", makeData(5000, 1));
    f.session.openRange = () => { throw new Error("boom"); };
    await f.settled();
    expect(f.deps.reservations.reservedByOthers(-1)).toBe(0);
  });

  it("keeps the reservation while transferring and shrinks it per finished unit", async () => {
    const seen: number[] = [];
    const h = makeHarness({ session: { onChunk: () => void seen.push(h.deps.reservations.reservedByOthers(-1)) } });
    h.session.set("A/a.bin", makeData(8000, 1));
    h.session.set("B/a.bin", makeData(9000, 2));
    await h.settled();
    expect(Math.max(...seen)).toBe(17_000);
    expect(seen.includes(9000)).toBe(true);
  });
});
