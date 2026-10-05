import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLogger } from "../../src/logger.js";
import { recoverPromoting } from "../../src/run/recovery.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

const crash = { hooks: { afterRename: () => { throw new Error("crash"); } } };
const recover = (h: ReturnType<typeof makeHarness>) => recoverPromoting({ stores: h.stores, logger: buildLogger("silent", false) });
const conflicts = async (dir: string): Promise<string[]> => (await fsp.readdir(dir, { recursive: true })).filter((n) => n.includes("conflict"));

describe("recoverPromoting", () => {
  it("commits the ledger after a crash between dir rename and ledger, without re-download or conflict file", async () => {
    const h = makeHarness({ deps: crash });
    const data = makeData(8000, 1);
    h.session.set("Pack/a.mkv", data);
    h.session.set("Pack/b.mkv", makeData(9000, 2));
    await h.settled();
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    const res = await recover(h);
    expect(res).toEqual({ committedUnits: ["Pack"], discardedFiles: 0, resumableFiles: 0 });
    expect(h.stores.ledger.active(h.jobId).size).toBe(2);
    expect(h.stores.ledger.completedUnits(h.jobId).has("Pack")).toBe(true);
    expect(h.stores.partials.listPromoting()).toEqual([]);
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    const next = await makeHarnessRun(h);
    expect(next.state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(before);
    expect(await conflicts(h.local)).toEqual([]);
    expect(readFileSync(path.join(h.local, "Pack/a.mkv")).equals(data)).toBe(true);
  });

  it("keeps the server spelling of an NFD name when committing a recovered unit", async () => {
    const h = makeHarness();
    const nfc = "caf\u00e9.mkv";
    const nfd = nfc.normalize("NFD");
    const final = path.join(h.local, nfc);
    await fsp.writeFile(final, makeData(100, 1));
    const part = h.stores.partials.create({ jobId: h.jobId, remotePath: nfc, remoteSize: 100, remoteMtimeMs: 1, stagingPath: path.join(h.local, "gone"), remoteRaw: nfd }, [{ idx: 0, startByte: 0, endByte: 100 }]);
    h.stores.partials.setPromoting(part.id, final);
    expect((await recover(h)).committedUnits).toEqual([nfc]);
    expect(h.stores.ledger.get(h.jobId, nfc)?.remoteRaw).toBe(nfd);
  });

  it("recovers a single loose file promoted just before the crash", async () => {
    const h = makeHarness({ deps: crash });
    h.session.set("movie.mkv", makeData(8000, 1));
    await h.settled();
    expect((await recover(h)).committedUnits).toEqual(["movie.mkv"]);
    expect(h.stores.ledger.active(h.jobId).get("movie.mkv")?.size).toBe(8000);
  });

  it("recovers a per-file promote into an existing pack", async () => {
    let crashNow = false;
    const h = makeHarness({ deps: { hooks: { afterRename: () => { if (crashNow) throw new Error("crash"); } } } });
    h.session.set("Pack/a.mkv", makeData(5000, 1));
    await h.settled();
    h.session.set("Pack/b.mkv", makeData(6000, 2));
    await h.exec();
    h.clock.t += 5000;
    crashNow = true;
    await h.exec();
    expect(h.stores.ledger.active(h.jobId).size).toBe(1);
    expect((await recover(h)).committedUnits).toEqual(["Pack"]);
    expect([...h.stores.ledger.active(h.jobId).keys()].sort()).toEqual(["Pack/a.mkv", "Pack/b.mkv"]);
    expect(await conflicts(h.local)).toEqual([]);
  });

  it("keeps a promoting partial whose staged file was never renamed, resets it to downloading, and finalizes without re-download", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(5000, 1));
    await h.exec();
    h.clock.t += 5000;
    crashAfterIntent(h, 1);
    await h.exec();
    const row = h.stores.partials.get(h.jobId, "a.bin")!;
    expect(row.promoteState).toBe("promoting");
    const res = await recover(h);
    expect(res).toEqual({ committedUnits: [], discardedFiles: 0, resumableFiles: 1 });
    expect(h.stores.partials.get(h.jobId, "a.bin")?.promoteState).toBe("downloading");
    expect(existsSync(row.stagingPath)).toBe(true);
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(before);
    expect(existsSync(path.join(h.local, "a.bin"))).toBe(true);
    expect(await conflicts(h.local)).toEqual([]);
  });

  it("does not trust a same-size older final file while the staged file still exists: it is moved aside, not overwritten", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(5000, 1));
    await h.exec();
    h.clock.t += 5000;
    crashAfterIntent(h, 1);
    await h.exec();
    await fsp.writeFile(path.join(h.local, "a.bin"), Buffer.alloc(5000, 7));
    const res = await recover(h);
    expect(res.discardedFiles).toBe(0);
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(await conflicts(h.local)).toHaveLength(1);
    expect(readFileSync(path.join(h.local, "a.bin")).equals(makeData(5000, 1))).toBe(true);
  });

  it("crash after renaming A but before B: recovery is per file, nothing is re-downloaded, the unit commits only when both are promoted", async () => {
    const h = makeHarness({ job: { unitMode: "top_dir" } });
    const [da, db] = [makeData(5000, 1), makeData(5000, 2)];
    h.session.set("P/a.bin", da);
    h.session.set("P/b.bin", db);
    await h.exec();
    h.clock.t += 5000;
    crashAfterIntent(h, 2);
    await h.exec();
    const [a, b] = ["P/a.bin", "P/b.bin"].map((p) => h.stores.partials.get(h.jobId, p)!);
    await fsp.mkdir(path.dirname(a!.finalPath!), { recursive: true });
    await fsp.rename(a!.stagingPath, a!.finalPath!);
    const res = await recover(h);
    expect(res).toEqual({ committedUnits: [], discardedFiles: 0, resumableFiles: 2 });
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    expect(h.stores.ledger.completedUnits(h.jobId).has("P")).toBe(false);
    expect(existsSync(b!.stagingPath)).toBe(true);
    expect(h.stores.partials.get(h.jobId, "P/a.bin")).toBeDefined();
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(before);
    expect(await conflicts(h.local)).toEqual([]);
    expect(readFileSync(path.join(h.local, "P/a.bin")).equals(da)).toBe(true);
    expect(readFileSync(path.join(h.local, "P/b.bin")).equals(db)).toBe(true);
    expect([...h.stores.ledger.active(h.jobId).keys()].sort()).toEqual(["P/a.bin", "P/b.bin"]);
    expect(h.stores.ledger.completedUnits(h.jobId).has("P")).toBe(true);
  });

  it("forgets only a file whose staged and final bytes are both gone", async () => {
    const h = makeHarness({ job: { unitMode: "top_dir" } });
    h.session.set("P/a.bin", makeData(5000, 1));
    h.session.set("P/b.bin", makeData(5000, 2));
    await h.exec();
    h.clock.t += 5000;
    crashAfterIntent(h, 2);
    await h.exec();
    const a = h.stores.partials.get(h.jobId, "P/a.bin")!;
    await fsp.rm(a.stagingPath);
    const res = await recover(h);
    expect(res).toEqual({ committedUnits: [], discardedFiles: 1, resumableFiles: 1 });
    expect(h.stores.partials.get(h.jobId, "P/a.bin")).toBeUndefined();
  });

  it("commits recovered units with a pending remote action when after_sync is not keep", async () => {
    const h = makeHarness({ deps: crash, job: { afterSync: "delete" } });
    h.session.set("a.bin", makeData(5000, 1));
    await h.settled();
    await recover(h);
    const rows = h.db.prepare("SELECT remote_action, remote_action_at FROM ledger").all() as { remote_action: string; remote_action_at: number | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.remote_action).toBe("pending");
    expect(rows[0]!.remote_action_at).not.toBeNull();
  });

  it("an ENOSPC-like failure mid-promote then rerun: no re-download, no conflict file", async () => {
    const h = makeHarness({ job: { unitMode: "top_dir" }, deps: { backoff: async () => {} } });
    const [da, db] = [makeData(5000, 1), makeData(5000, 2)];
    h.session.set("P/a.bin", da);
    h.session.set("P/b.bin", db);
    await fsp.mkdir(path.join(h.local, "P")); // existing pack dir: promoted file by file, not by whole-dir rename
    await h.exec();
    h.clock.t += 5000;
    const orig = fsp.rename;
    let renames = 0;
    const spy = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (++renames === 2) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return orig(from, to);
    });
    const failed = await h.exec();
    spy.mockRestore();
    expect(failed.state).toBe("failed");
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(before);
    expect(await conflicts(h.local)).toEqual([]);
    expect(readFileSync(path.join(h.local, "P/a.bin")).equals(da)).toBe(true);
    expect(readFileSync(path.join(h.local, "P/b.bin")).equals(db)).toBe(true);
    expect(h.stores.ledger.completedUnits(h.jobId).has("P")).toBe(true);
  });

  it("forgets the file when the final file has the wrong size and staging is gone", async () => {
    const h = makeHarness({ deps: crash });
    h.session.set("a.bin", makeData(5000, 1));
    await h.settled();
    await fsp.writeFile(path.join(h.local, "a.bin"), "short");
    expect((await recover(h)).discardedFiles).toBe(1);
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
  });

  it("leaves downloading partials alone and is a no-op without promoting rows", async () => {
    const ctrlHarness = makeHarness({ session: { onChunk: (sent) => void (sent > 60_000 && ac.abort()) }, cfg: { checkpointBytes: 4096 } });
    const ac = new AbortController();
    ctrlHarness.session.set("big.bin", makeData(200_000, 3));
    await ctrlHarness.settled({ signal: ac.signal });
    expect(await recover(ctrlHarness)).toEqual({ committedUnits: [], discardedFiles: 0, resumableFiles: 0 });
    expect(ctrlHarness.stores.partials.get(ctrlHarness.jobId, "big.bin")?.promoteState).toBe("downloading");
  });

  it("records an activity row for a recovered unit", async () => {
    const h = makeHarness({ deps: crash });
    h.session.set("a.bin", makeData(5000, 1));
    await h.settled();
    await recover(h);
    expect(h.activity().some((a) => a.category === "recovery" && a.summary.includes("a.bin"))).toBe(true);
  });
});

/** Simulates a crash right after the promoting intent of the `nth` file is written, before any rename. */
function crashAfterIntent(h: ReturnType<typeof makeHarness>, nth: number): void {
  const orig = h.stores.partials.setPromoting.bind(h.stores.partials);
  let calls = 0;
  h.stores.partials.setPromoting = (id, finalPath) => {
    orig(id, finalPath);
    if (++calls === nth) throw new Error("crash");
  };
}

async function makeHarnessRun(h: ReturnType<typeof makeHarness>) {
  return h.exec();
}
