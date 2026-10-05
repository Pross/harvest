import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

const sha = (b: Buffer, algo = "sha256") => createHash(algo).update(b).digest("hex");
const stagingOf = (h: { local: string; jobId: number }) => path.join(h.local, ".harvest-staging", String(h.jobId));
const warns = (h: ReturnType<typeof makeHarness>) => h.activity().filter((a) => a.severity === "warn");

describe("finalize: remote re-check before promote", () => {
  it("discards, does not promote and does not delete when the remote size changes", async () => {
    const h = makeHarness({ job: { afterSync: "delete" }, session: { onStat: (abs, n) => void (n === 1 && h.session.set("a.bin", makeData(7000, 9))) } });
    h.session.set("a.bin", makeData(5000, 1));
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(existsSync(path.join(h.local, "a.bin"))).toBe(false);
    expect(existsSync(path.join(stagingOf(h), "a.bin"))).toBe(false);
    expect(h.stores.partials.get(h.jobId, "a.bin")).toBeUndefined();
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    expect(h.session.removed).toEqual([]);
    expect(h.stores.runs.filesForRun(r.runId)[0]).toMatchObject({ state: "failed" });
    expect(h.stores.runs.filesForRun(r.runId)[0]?.error).toContain("changed during transfer");
  });

  it("detects an mtime-only change", async () => {
    const h = makeHarness({ session: { onStat: (abs, n) => void (n === 1 && h.session.set("a.bin", makeData(5000, 1), 4242)) } });
    h.session.set("a.bin", makeData(5000, 1), 1000);
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(existsSync(path.join(h.local, "a.bin"))).toBe(false);
  });

  it("falls back to size only when the remote mtime is null", async () => {
    const h = makeHarness();
    h.session.set("a.bin", makeData(5000, 1), null);
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(existsSync(path.join(h.local, "a.bin"))).toBe(true);
  });

  it("detects a size change with a null mtime", async () => {
    const h = makeHarness({ session: { onStat: (abs, n) => void (n === 1 && h.session.set("a.bin", makeData(5001, 1), null)) } });
    h.session.set("a.bin", makeData(5000, 1), null);
    expect((await h.settled()).state).toBe("failed");
  });

  it("treats a remote file that vanished as changed", async () => {
    const h = makeHarness({ session: { onStat: (abs, n) => void (n === 1 && h.session.files.delete(abs)) } });
    h.session.set("a.bin", makeData(5000, 1));
    expect((await h.settled()).state).toBe("failed");
    expect(existsSync(path.join(h.local, "a.bin"))).toBe(false);
  });

  it("a changed file holds the whole unit while the unchanged sibling keeps its partial", async () => {
    const h = makeHarness({ session: { onStat: (abs, n) => void (n === 1 && abs.endsWith("b.bin") && h.session.set("P/b.bin", makeData(100, 3))) } });
    h.session.set("P/a.bin", makeData(5000, 1));
    h.session.set("P/b.bin", makeData(5000, 2));
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(existsSync(path.join(h.local, "P"))).toBe(false);
    expect(h.stores.partials.get(h.jobId, "P/a.bin")).toBeDefined();
    expect(h.stores.partials.get(h.jobId, "P/b.bin")).toBeUndefined();
  });
});

describe("finalize: promote journal and ordering", () => {
  it("writes the promoting intent for every file before the rename and commits the ledger after", async () => {
    const seen: { promoting: number; ledger: number; finals: string[] }[] = [];
    const h = makeHarness({ deps: { hooks: { afterRename: () => void seen.push({ promoting: h.stores.partials.listPromoting().length, ledger: h.stores.ledger.active(h.jobId).size, finals: h.stores.partials.listPromoting().map((p) => p.finalPath ?? "") }) } } });
    h.session.set("P/a.bin", makeData(5000, 1));
    h.session.set("P/b.bin", makeData(5000, 2));
    await h.settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ promoting: 2, ledger: 0 });
    expect(seen[0]?.finals.sort()).toEqual([path.join(h.local, "P/a.bin"), path.join(h.local, "P/b.bin")]);
    expect(h.stores.ledger.active(h.jobId).size).toBe(2);
    expect(h.stores.partials.listPromoting()).toEqual([]);
  });

  it("a hook failure after the rename fails the unit and keeps the promoting rows", async () => {
    const h = makeHarness({ job: { afterSync: "delete" }, deps: { hooks: { afterRename: () => { throw new Error("crash"); } } } });
    h.session.set("P/a.bin", makeData(5000, 1));
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(existsSync(path.join(h.local, "P/a.bin"))).toBe(true);
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    expect(h.stores.partials.listPromoting()).toHaveLength(1);
    expect(h.session.removed).toEqual([]);
  });

  it("does not promote stale staged leftovers of a unit", async () => {
    const h = makeHarness();
    await fsp.mkdir(path.join(stagingOf(h), "P"), { recursive: true });
    await fsp.writeFile(path.join(stagingOf(h), "P/stale.bin"), "old");
    h.session.set("P/a.bin", makeData(5000, 1));
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(existsSync(path.join(h.local, "P/a.bin"))).toBe(true);
    expect(existsSync(path.join(h.local, "P/stale.bin"))).toBe(false);
  });

  it("creates nested directories when promoting file by file", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    h.session.set("x/y/z.bin", makeData(2000, 1));
    await h.settled();
    expect(readFileSync(path.join(h.local, "x/y/z.bin")).length).toBe(2000);
  });
});

describe("finalize: conflicts and resync", () => {
  it("moves an unrelated existing local file aside as .harvest-conflict-<ts> with a warning", async () => {
    const h = makeHarness();
    h.session.set("Pack/a.mkv", makeData(5000, 1));
    await h.settled();
    await fsp.writeFile(path.join(h.local, "Pack/b.mkv"), "mine");
    const newData = makeData(6000, 2);
    h.session.set("Pack/b.mkv", newData);
    await h.exec();
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(readFileSync(path.join(h.local, "Pack/b.mkv")).equals(newData)).toBe(true);
    expect(readFileSync(path.join(h.local, `Pack/b.mkv.harvest-conflict-${h.clock.t}`), "utf8")).toBe("mine");
    expect(warns(h).some((a) => a.category === "conflict")).toBe(true);
  });

  it("renames over the old file without a conflict file after an explicit forget", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    h.session.set("a.bin", makeData(3000, 1));
    await h.settled();
    h.stores.ledger.forgetFile(h.jobId, "a.bin");
    const fresh = makeData(3000, 2);
    h.session.set("a.bin", fresh);
    await h.exec();
    h.clock.t += 5000;
    const r = await h.exec();
    expect(r.state).toBe("succeeded");
    expect(readFileSync(path.join(h.local, "a.bin")).equals(fresh)).toBe(true);
    expect((await fsp.readdir(h.local)).filter((n) => n.includes("conflict"))).toEqual([]);
    expect(h.stores.ledger.forgottenPaths(h.jobId).size).toBe(0);
  });
});

describe("finalize: replace-or-move-aside rule", () => {
  const conflictsIn = async (dir: string) => (await fsp.readdir(dir)).filter((n) => n.includes("conflict"));

  it("a forgotten file whose existing local copy has a DIFFERENT size is moved aside, not overwritten", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    h.session.set("a.bin", makeData(3000, 1));
    await h.settled();
    h.stores.ledger.forgetFile(h.jobId, "a.bin");
    const fresh = makeData(4000, 2);
    h.session.set("a.bin", fresh);
    await h.exec();
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(readFileSync(path.join(h.local, "a.bin")).equals(fresh)).toBe(true);
    expect(await conflictsIn(h.local)).toHaveLength(1);
  });

  it("a non-forgotten same-size foreign file is moved aside too", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    await fsp.writeFile(path.join(h.local, "a.bin"), Buffer.alloc(3000, 5));
    h.session.set("a.bin", makeData(3000, 1));
    expect((await h.settled()).state).toBe("succeeded");
    expect(await conflictsIn(h.local)).toHaveLength(1);
    expect(readFileSync(path.join(h.local, "a.bin")).equals(makeData(3000, 1))).toBe(true);
  });

  it("a promoting partial (own interrupted promote) over a different-size final file moves it aside", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    h.session.set("a.bin", makeData(3000, 1));
    await h.exec();
    h.clock.t += 5000;
    const orig = h.stores.partials.setPromoting.bind(h.stores.partials);
    h.stores.partials.setPromoting = (id, fp) => { orig(id, fp); throw new Error("crash after intent"); };
    await h.exec();
    h.stores.partials.setPromoting = orig;
    await fsp.writeFile(path.join(h.local, "a.bin"), "different size");
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(await conflictsIn(h.local)).toHaveLength(1);
  });

  it("a promoting partial over a same-size final file renames over it without a conflict file", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    h.session.set("a.bin", makeData(3000, 1));
    await h.exec();
    h.clock.t += 5000;
    const orig = h.stores.partials.setPromoting.bind(h.stores.partials);
    h.stores.partials.setPromoting = (id, fp) => { orig(id, fp); throw new Error("crash after intent"); };
    await h.exec();
    h.stores.partials.setPromoting = orig;
    await fsp.writeFile(path.join(h.local, "a.bin"), Buffer.alloc(3000, 9));
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(await conflictsIn(h.local)).toEqual([]);
    expect(readFileSync(path.join(h.local, "a.bin")).equals(makeData(3000, 1))).toBe(true);
  });
});

describe("finalize: containment and durability", () => {
  it("refuses to promote through a pre-existing symlink that leaves the local path", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    const elsewhere = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
    symlinkSync(elsewhere, path.join(h.local, "Show"));
    h.session.set("Show/a.bin", makeData(3000, 1));
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(await fsp.readdir(elsewhere)).toEqual([]);
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    expect(h.activity().some((a) => a.summary.includes("symlink"))).toBe(true);
  });

  it("refuses a whole-directory promote through a symlinked unit directory", async () => {
    const h = makeHarness();
    const elsewhere = mkdtempSync(path.join(tmpdir(), "elsewhere-"));
    symlinkSync(elsewhere, path.join(h.local, "Show"));
    h.session.set("Show/a.bin", makeData(3000, 1));
    expect((await h.settled()).state).toBe("failed");
    expect(await fsp.readdir(elsewhere)).toEqual([]);
  });

  it("fsyncs the staging parent directory and every directory created by mkdir -p", async () => {
    const h = makeHarness({ job: { unitMode: "file" } });
    h.session.set("x/y/z.bin", makeData(2000, 1));
    await h.exec();
    h.clock.t += 5000;
    const opened: string[] = [];
    const orig = fsp.open;
    const spy = vi.spyOn(fsp, "open").mockImplementation(((p: string, ...rest: unknown[]) => (opened.push(String(p)), (orig as (...a: unknown[]) => unknown)(p, ...rest))) as typeof fsp.open);
    await h.exec();
    spy.mockRestore();
    const real = (p: string) => path.resolve(h.local, p);
    for (const d of [h.local, real("x"), real("x/y"), path.join(stagingOf(h), "x/y")]) expect(opened).toContain(d);
  });
});

describe("finalize: after_sync", () => {
  it("deletes the remote file only after the ledger commit", async () => {
    const h = makeHarness({ job: { afterSync: "delete" } });
    h.session.set("a.bin", makeData(3000, 1));
    const remove = h.session.remove.bind(h.session);
    const ledgerAtRemove: number[] = [];
    const rowAtRemove: unknown[] = [];
    h.session.remove = async (abs) => {
      ledgerAtRemove.push(h.stores.ledger.active(h.jobId).size);
      rowAtRemove.push(h.stores.ledger.get(h.jobId, "a.bin"));
      await remove(abs);
    };
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(ledgerAtRemove).toEqual([1]);
    // Committed pending (due now) before the delete, so a crash in between is retried by maintenance.
    expect(rowAtRemove[0]).toMatchObject({ remoteAction: "pending", remoteActionAt: h.clock.t });
    expect(h.session.files.size).toBe(0);
    expect(h.stores.ledger.listActive(h.jobId, { limit: 5, offset: 0 }).rows[0]).toMatchObject({ remoteAction: "done" });
  });

  it("deletes every file of a pack", async () => {
    const h = makeHarness({ job: { afterSync: "delete" } });
    h.session.set("P/a.bin", makeData(3000, 1));
    h.session.set("P/b.bin", makeData(3000, 2));
    await h.settled();
    expect(h.session.removed.sort()).toEqual(["/remote/P/a.bin", "/remote/P/b.bin"]);
  });

  it("does not delete when the remote changed after the ledger commit", async () => {
    const h = makeHarness({ job: { afterSync: "delete" }, session: { onStat: (abs, n) => void (n === 2 && h.session.set("a.bin", makeData(3000, 1), 999)) } });
    h.session.set("a.bin", makeData(3000, 1));
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(h.session.removed).toEqual([]);
    expect(h.stores.ledger.listActive(h.jobId, { limit: 5, offset: 0 }).rows[0]).toMatchObject({ remoteAction: "pending" });
    expect(warns(h).some((a) => a.summary.includes("remote copy kept"))).toBe(true);
  });

  it("a failed remote delete marks remote_action failed, warns and still succeeds", async () => {
    const h = makeHarness({ job: { afterSync: "delete" } });
    h.session.set("a.bin", makeData(3000, 1));
    h.session.failRemove = new Error("550 permission denied");
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    const row = h.stores.ledger.listActive(h.jobId, { limit: 5, offset: 0 }).rows[0];
    expect(row).toMatchObject({ remoteAction: "failed" });
    expect(row?.remoteActionAt).toBe(h.clock.t);
    expect(warns(h).some((a) => a.summary.includes("550 permission denied"))).toBe(true);
    expect(h.stores.ledger.duePendingActions(h.clock.t + 1)).toHaveLength(1);
  });

  it("keep leaves the remote untouched with remote_action none", async () => {
    const h = makeHarness({ job: { afterSync: "keep" } });
    h.session.set("a.bin", makeData(3000, 1));
    await h.settled();
    expect(h.session.removed).toEqual([]);
    expect(h.stores.ledger.listActive(h.jobId, { limit: 5, offset: 0 }).rows[0]).toMatchObject({ remoteAction: "none" });
  });
});

describe("finalize: verification", () => {
  it("checksum mode compares the remote hash and stores it in the ledger", async () => {
    const data = makeData(5000, 1);
    const h = makeHarness({ job: { verify: "checksum" }, session: { hash: async (_a, algo) => (algo === "sha256" ? sha(data) : null) } });
    h.session.set("a.bin", data);
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(h.stores.ledger.listActive(h.jobId, { limit: 5, offset: 0 }).rows[0]?.hash).toBe(`sha256:${sha(data)}`);
  });

  it("falls through to md5 when the server has no sha256", async () => {
    const data = makeData(5000, 1);
    const h = makeHarness({ job: { verify: "checksum" }, session: { hash: async (_a, algo) => (algo === "md5" ? sha(data, "md5") : null) } });
    h.session.set("a.bin", data);
    await h.settled();
    expect(h.stores.ledger.listActive(h.jobId, { limit: 5, offset: 0 }).rows[0]?.hash).toBe(`md5:${sha(data, "md5")}`);
  });

  it("a checksum mismatch discards the partial and fails the file", async () => {
    const h = makeHarness({ job: { verify: "checksum" }, session: { hash: async () => "0".repeat(64) } });
    h.session.set("a.bin", makeData(5000, 1));
    const r = await h.settled();
    expect(r.state).toBe("failed");
    expect(existsSync(path.join(h.local, "a.bin"))).toBe(false);
    expect(h.stores.partials.get(h.jobId, "a.bin")).toBeUndefined();
    expect(existsSync(path.join(stagingOf(h), "a.bin"))).toBe(false);
    expect(h.stores.runs.filesForRun(r.runId)[0]?.error).toMatch(/mismatch/);
  });

  it("warns once and verifies by size when the session has no hash support", async () => {
    const h = makeHarness({ job: { verify: "checksum" } });
    h.session.set("P/a.bin", makeData(3000, 1));
    h.session.set("P/b.bin", makeData(3000, 2));
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(warns(h).filter((a) => a.summary.includes("no remote hash"))).toHaveLength(1);
    expect(h.stores.ledger.listActive(h.jobId, { limit: 5, offset: 0 }).rows[0]?.hash).toBeNull();
  });

  it("warns when the server reports a null hash", async () => {
    const h = makeHarness({ job: { verify: "checksum" }, session: { hash: async () => null } });
    h.session.set("a.bin", makeData(3000, 1));
    expect((await h.settled()).state).toBe("succeeded");
    expect(warns(h).some((a) => a.summary.includes("no remote hash"))).toBe(true);
  });

  it("size mode never asks for a hash and records no warning", async () => {
    let asked = 0;
    const h = makeHarness({ session: { hash: async () => (void asked++, null) } });
    h.session.set("a.bin", makeData(3000, 1));
    await h.settled();
    expect(asked).toBe(0);
    expect(warns(h)).toEqual([]);
  });
});

describe("finalize: delayed after_sync modes", () => {
  const row = (h: ReturnType<typeof makeHarness>) => h.stores.ledger.listActive(h.jobId, { limit: 5, offset: 0 }).rows[0];

  it("delete_after_days commits pending at now + days and leaves the remote file", async () => {
    const h = makeHarness({ job: { afterSync: "delete_after_days", afterDays: 3 } });
    h.session.set("a.bin", makeData(3000, 1));
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(h.session.removed).toEqual([]);
    expect(h.session.files.size).toBe(1);
    expect(row(h)).toMatchObject({ remoteAction: "pending", remoteActionAt: h.clock.t + 3 * 86_400_000 });
  });

  it("move relocates the remote file immediately and marks the row done", async () => {
    const h = makeHarness({ job: { afterSync: "move", moveTo: "/done" } });
    h.session.set("P/a.bin", makeData(3000, 1));
    await h.settled();
    expect(h.session.moved).toEqual([["/remote/P/a.bin", "/done/P/a.bin"]]);
    expect(row(h)).toMatchObject({ remoteAction: "done" });
  });

  it("move picks a free name when the destination exists", async () => {
    const h = makeHarness({ job: { afterSync: "move", moveTo: "/done" } });
    h.session.set("a.bin", makeData(3000, 1));
    h.session.files.set("/done/a.bin", { data: makeData(10, 5), mtimeMs: 1 });
    await h.settled();
    expect(h.session.moved).toEqual([["/remote/a.bin", "/done/a.1.bin"]]);
    expect(h.session.files.get("/done/a.bin")?.data.length).toBe(10);
  });

  it("a failed move marks the row failed with a warning and the run still succeeds", async () => {
    const h = makeHarness({ job: { afterSync: "move", moveTo: "/done" } });
    h.session.set("a.bin", makeData(3000, 1));
    h.session.failMove = new Error("boom");
    const r = await h.settled();
    expect(r.state).toBe("succeeded");
    expect(row(h)).toMatchObject({ remoteAction: "failed" });
    expect(warns(h).some((a) => a.summary.includes("remote move failed"))).toBe(true);
  });

  it("move leaves a pending row when the remote changed after the commit", async () => {
    const h = makeHarness({ job: { afterSync: "move", moveTo: "/done" }, session: { onStat: (abs, n) => void (n === 2 && h.session.set("a.bin", makeData(3000, 1), 999)) } });
    h.session.set("a.bin", makeData(3000, 1));
    await h.settled();
    expect(h.session.moved).toEqual([]);
    expect(row(h)).toMatchObject({ remoteAction: "pending" });
  });
});
