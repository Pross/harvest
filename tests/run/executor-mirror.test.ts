import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DRY_DELETE, DRY_MIRROR_CATEGORY, type DryMirrorSummary } from "../../src/run/mirror-sweep.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness, REMOTE_ROOT } from "./executor-harness.js";

const armed = { mode: "mirror" as const, mirrorArmedAt: 1 };
const remote = (rel: string): string => path.posix.join(REMOTE_ROOT, rel);
const at = (h: { local: string }, rel: string): string => path.join(h.local, rel);

/** A mirror job that already synced `rels`, with the remote still holding them. */
async function synced(rels: string[], job: Record<string, unknown> = armed) {
  const h = makeHarness({ job });
  rels.forEach((r, i) => h.session.set(r, makeData(3000 + i, i + 1)));
  expect((await h.settled()).state).toBe("succeeded");
  return h;
}

describe("mirror: guards", () => {
  it("refuses a real run until a dry run has armed the job", async () => {
    const h = makeHarness({ job: { mode: "mirror" } });
    h.session.set("a.bin", makeData(2000, 1));
    const r = await h.exec();
    expect(r.state).toBe("failed");
    expect(r.row.error).toMatch(/not armed/);
    expect(existsSync(at(h, "a.bin"))).toBe(false);
  });

  it("refuses any mirror run when the job deletes or moves remote files after sync", async () => {
    for (const afterSync of ["delete", "move", "delete_after_days"] as const) {
      const h = makeHarness({ job: { ...armed, afterSync, afterDays: 1, moveTo: "/done" } });
      expect((await h.exec({ dryRun: true })).row.error).toMatch(/After sync: keep/);
      expect((await h.exec()).row.error).toMatch(/After sync: keep/);
    }
  });
});

describe("mirror: dry run", () => {
  it("records what would be deleted, touches nothing and arms the job", async () => {
    const h = await synced(["a.bin", "b.bin", "c.bin"]);
    h.session.files.delete(remote("b.bin"));
    h.stores.jobs.update(h.jobId, { mirrorArmedAt: null });
    const r = await h.exec({ dryRun: true });
    expect(r.state).toBe("succeeded");
    expect(h.stores.runs.filesForRun(r.runId).filter((f) => f.state === DRY_DELETE).map((f) => f.remotePath)).toEqual(["b.bin"]);
    const meta = h.stores.activity.list({ runId: r.runId, category: DRY_MIRROR_CATEGORY, limit: 1 })[0]!.meta as DryMirrorSummary;
    expect(meta).toEqual({ wouldDelete: 1, refused: null });
    expect(existsSync(at(h, "b.bin"))).toBe(true);
    expect(h.stores.ledger.active(h.jobId).has("b.bin")).toBe(true);
    expect(h.jobRow().mirrorArmedAt).toBe(h.clock.t);
  });

  it("does not arm a job that was edited while the dry run was in flight", async () => {
    const h = await synced(["a.bin", "b.bin"]);
    h.stores.jobs.update(h.jobId, { mirrorArmedAt: null });
    const list = h.session.list.bind(h.session);
    h.session.list = async (root, o) => {
      h.stores.jobs.update(h.jobId, { localPath: path.join(h.local, "elsewhere") });
      return list(root, o);
    };
    await h.exec({ dryRun: true });
    expect(h.jobRow().mirrorArmedAt).toBeNull();
  });

  it("reports a refused sweep in the summary instead of listing deletes", async () => {
    const h = await synced(["a.bin", "b.bin"]);
    h.session.files.clear();
    const r = await h.exec({ dryRun: true });
    const meta = h.stores.activity.list({ runId: r.runId, category: DRY_MIRROR_CATEGORY, limit: 1 })[0]!.meta as DryMirrorSummary;
    expect(meta.wouldDelete).toBe(0);
    expect(meta.refused).toMatch(/listing is empty/);
    expect(h.stores.runs.filesForRun(r.runId).filter((f) => f.state === DRY_DELETE)).toEqual([]);
  });
});

describe("mirror: real runs", () => {
  it("deletes local files that left the remote, prunes empty folders and forgets the ledger row", async () => {
    const h = await synced(["Show/e1.mkv", "Show/e2.mkv", "Other/x.bin"]);
    h.session.files.delete(remote("Other/x.bin"));
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(existsSync(at(h, "Other/x.bin"))).toBe(false);
    expect(existsSync(at(h, "Other"))).toBe(false);
    expect(existsSync(at(h, "Show/e1.mkv"))).toBe(true);
    expect(h.stores.ledger.active(h.jobId).has("Other/x.bin")).toBe(false);
    expect(h.stores.ledger.active(h.jobId).has("Show/e1.mkv")).toBe(true);
    expect(h.activity().some((a) => a.category === "mirror" && /removed 1 local/.test(a.summary))).toBe(true);
  });

  it("never touches files Harvest did not place", async () => {
    const h = await synced(["a.bin", "b.bin"]);
    writeFileSync(at(h, "mine.txt"), "hand added");
    mkdirSync(at(h, "my-folder"));
    writeFileSync(at(h, "my-folder/note.txt"), "keep");
    h.session.files.delete(remote("a.bin"));
    await h.exec();
    expect(existsSync(at(h, "a.bin"))).toBe(false);
    expect(readFileSync(at(h, "mine.txt"), "utf8")).toBe("hand added");
    expect(readFileSync(at(h, "my-folder/note.txt"), "utf8")).toBe("keep");
  });

  it("keeps a file that changed locally, warns, and stops tracking it", async () => {
    const h = await synced(["a.bin", "b.bin"]);
    writeFileSync(at(h, "a.bin"), "edited by hand");
    h.session.files.delete(remote("a.bin"));
    const r = await h.exec();
    expect(r.state).toBe("partial");
    expect(readFileSync(at(h, "a.bin"), "utf8")).toBe("edited by hand");
    expect(h.stores.ledger.active(h.jobId).has("a.bin")).toBe(false);
    expect(h.activity().some((a) => a.severity === "warn" && /Mirror kept a\.bin.*changed locally/.test(a.summary))).toBe(true);
  });

  it("keeps a symlink that sits where a synced file was", async () => {
    const h = await synced(["a.bin", "b.bin"]);
    const target = at(h, "b.bin");
    await import("node:fs").then((fs) => { fs.rmSync(at(h, "a.bin")); symlinkSync(target, at(h, "a.bin")); });
    h.session.files.delete(remote("a.bin"));
    const r = await h.exec();
    expect(r.state).toBe("partial");
    expect(existsSync(target)).toBe(true);
    expect(h.activity().some((a) => /Mirror kept a\.bin.*not a regular file/.test(a.summary))).toBe(true);
  });

  it("deletes nothing when the listing is empty or most of the ledger would go", async () => {
    const h = await synced(["a.bin", "b.bin"]);
    h.session.files.clear();
    const r = await h.exec();
    expect(r.state).toBe("partial");
    expect(existsSync(at(h, "a.bin")) && existsSync(at(h, "b.bin"))).toBe(true);
    expect(h.stores.ledger.active(h.jobId).size).toBe(2);
    expect(h.activity().some((a) => /Mirror sweep skipped: The remote listing is empty/.test(a.summary))).toBe(true);
  });

  it("deletes nothing when this run dropped a download for lack of space", async () => {
    const h = await synced(["a.bin", "b.bin"]);
    h.session.set("big.bin", makeData(40_000, 9));
    await h.exec();
    h.clock.t += 5000;
    h.session.files.delete(remote("a.bin"));
    h.deps.statfs = async () => ({ bavail: 100, bsize: 1 });
    const r = await h.exec();
    expect(r.state).toBe("skipped_space");
    expect(existsSync(at(h, "a.bin"))).toBe(true);
    expect(h.activity().some((a) => /Mirror sweep skipped: some downloads failed or were dropped/.test(a.summary))).toBe(true);
  });

  it("downloads a ledger file again when its local copy was deleted", async () => {
    const h = await synced(["a.bin", "b.bin"]);
    const data = h.session.files.get(remote("a.bin"))!.data;
    await import("node:fs").then((fs) => fs.rmSync(at(h, "a.bin")));
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(readFileSync(at(h, "a.bin")).equals(data)).toBe(true);
  });
});

describe("copy mode is unchanged", () => {
  it("never deletes locally and never re-downloads a deleted local file", async () => {
    const h = await synced(["a.bin", "b.bin"], {});
    await import("node:fs").then((fs) => fs.rmSync(at(h, "a.bin")));
    h.session.files.delete(remote("b.bin"));
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(existsSync(at(h, "a.bin"))).toBe(false);
    expect(existsSync(at(h, "b.bin"))).toBe(true);
    expect(h.activity().some((a) => a.category === "mirror")).toBe(false);
  });
});
