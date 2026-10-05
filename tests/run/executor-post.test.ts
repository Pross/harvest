import { existsSync, readFileSync, readdirSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLogger } from "../../src/logger.js";
import { recoverPromoting } from "../../src/run/recovery.js";
import type { AfterPromoteInput, ExtractInput, PostPipeline, PostResult } from "../../src/post/types.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

/** A fake extractor: every *.zip in the unit "contains" ep.mkv (written next to it). `mode` decides whether the archive is dropped. */
function fakePost(mode: "keep" | "delete", over: Partial<PostPipeline> = {}) {
  const afterPromote = vi.fn(async (_i: AfterPromoteInput): Promise<PostResult> => ({ warnings: [] }));
  const afterRun = vi.fn(async (_i: Parameters<PostPipeline["afterRun"]>[0]): Promise<PostResult> => ({ warnings: [] }));
  const extractInStaging = vi.fn(async (i: ExtractInput) => {
    const zips = i.files.filter((f) => f.endsWith(".zip"));
    const added: string[] = [];
    for (const z of zips) {
      const out = path.join(path.dirname(z), "ep.mkv");
      await fsp.writeFile(out, "EXTRACTED-VIDEO");
      added.push(out);
    }
    return { warnings: [], added, removed: mode === "delete" ? zips : [] };
  });
  return { post: { extractInStaging, afterPromote, afterRun, ...over } as PostPipeline, extractInStaging, afterPromote, afterRun };
}

const names = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((n) => !n.startsWith(".harvest-staging")).sort();
const crashOnce = () => { let armed = true; return { afterRename: () => { if (armed) { armed = false; throw new Error("crash"); } } }; };

describe("executor with post actions", () => {
  it("extracts in staging, promotes archive and extracted files together, ledger only has the remote file", async () => {
    const p = fakePost("keep");
    const h = makeHarness({ deps: { post: p.post } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    const res = await h.settled();
    expect(res.state).toBe("succeeded");
    expect(names(h.local)).toEqual(["Pack", "Pack/a.zip", "Pack/ep.mkv"]);
    expect([...h.stores.ledger.active(h.jobId).keys()]).toEqual(["Pack/a.zip"]);
    expect(p.extractInStaging.mock.calls[0]![0].unitDir).toMatch(/\.harvest-staging\/\d+\/Pack$/);
    expect(p.afterPromote.mock.calls[0]![0]).toMatchObject({ unitKey: "Pack", finalPaths: [path.join(h.local, "Pack/a.zip"), path.join(h.local, "Pack/ep.mkv")] });
    expect(p.afterRun.mock.calls.at(-1)![0]).toMatchObject({ state: "succeeded", summary: { filesOk: 1 } });
  });

  it("delete mode: archive is never promoted, removed after the ledger commit, remote still marked synced", async () => {
    const p = fakePost("delete");
    const h = makeHarness({ deps: { post: p.post }, job: { afterSync: "delete" } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    const res = await h.settled();
    expect(res.state).toBe("succeeded");
    expect(names(h.local)).toEqual(["Pack", "Pack/ep.mkv"]);
    expect(h.stores.ledger.active(h.jobId).has("Pack/a.zip")).toBe(true);
    expect(h.session.removed).toEqual(["/remote/Pack/a.zip"]);
    expect(p.afterPromote.mock.calls[0]![0].finalPaths).toEqual([path.join(h.local, "Pack/ep.mkv")]);
    expect(readdirSync(path.join(h.local, ".harvest-staging"), { recursive: true, encoding: "utf8" }).filter((n) => n.endsWith(".zip"))).toEqual([]);
  });

  it("a mix of archive and plain files promotes plain files and extracted files", async () => {
    const p = fakePost("delete");
    const h = makeHarness({ deps: { post: p.post } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    h.session.set("Pack/readme.txt", makeData(100, 2));
    await h.settled();
    expect(names(h.local)).toEqual(["Pack", "Pack/ep.mkv", "Pack/readme.txt"]);
    expect(h.stores.ledger.active(h.jobId).size).toBe(2);
  });

  it("warnings from any step make a succeeded run partial and show up as activity", async () => {
    const p = fakePost("keep", { afterPromote: async () => ({ warnings: ["chmod failed for ep.mkv: EPERM"] }) });
    const h = makeHarness({ deps: { post: p.post } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    const res = await h.settled();
    expect(res.state).toBe("partial");
    expect(h.activity().some((a) => a.category === "post" && a.summary.includes("EPERM"))).toBe(true);
    expect(p.afterRun.mock.calls.at(-1)![0].state).toBe("partial");
    expect(p.afterRun.mock.calls.at(-1)![0].summary.warnings).toEqual(["chmod failed for ep.mkv: EPERM"]);
  });

  it("a notification failure (warning or throw) is an activity entry only: the stored terminal state stays succeeded", async () => {
    const h = makeHarness({ deps: { post: fakePost("keep", { afterRun: async () => { throw new Error("notify boom"); } }).post } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    const res = await h.settled();
    expect(res.state).toBe("succeeded");
    expect(res.row.state).toBe("succeeded");
    expect(h.activity().some((a) => a.category === "notify" && a.summary.includes("notify boom"))).toBe(true);
    expect(existsSync(path.join(h.local, "Pack/a.zip"))).toBe(true);
  });

  it("extraction that throws leaves the archive in place and the run partial", async () => {
    const h = makeHarness({ deps: { post: fakePost("keep", { extractInStaging: async () => { throw new Error("pipeline bug"); } }).post } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    const res = await h.settled();
    expect(res.state).toBe("partial");
    expect(names(h.local)).toEqual(["Pack", "Pack/a.zip"]);
    expect(h.stores.ledger.active(h.jobId).has("Pack/a.zip")).toBe(true);
  });

  it("dry runs never call post actions", async () => {
    const p = fakePost("keep");
    const h = makeHarness({ deps: { post: p.post } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    await h.exec();
    h.clock.t += 5000;
    p.afterRun.mockClear();
    await h.exec({ dryRun: true });
    expect(p.extractInStaging).not.toHaveBeenCalled();
    expect(p.afterRun).not.toHaveBeenCalled();
  });

  it("file unit mode extracts next to the single archive", async () => {
    const p = fakePost("keep");
    const h = makeHarness({ deps: { post: p.post }, job: { unitMode: "file" } });
    h.session.set("a.zip", makeData(3000, 1));
    await h.settled();
    expect(names(h.local)).toEqual(["a.zip", "ep.mkv"]);
  });
});

describe("crash recovery with extracted files", () => {
  const recover = (h: ReturnType<typeof makeHarness>) => recoverPromoting({ stores: h.stores, logger: buildLogger("silent", false) });

  it("keep mode: crash after the directory rename commits the ledger on recovery; extracted files are in place", async () => {
    const h = makeHarness({ deps: { post: fakePost("keep").post, hooks: crashOnce() } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    await h.settled();
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    expect((await recover(h)).committedUnits).toEqual(["Pack"]);
    expect(names(h.local)).toEqual(["Pack", "Pack/a.zip", "Pack/ep.mkv"]);
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(before);
  });

  it("delete mode: crash mid-promote resumes without re-download, re-extracts idempotently and leaves no conflict files", async () => {
    const h = makeHarness({ deps: { post: fakePost("delete").post, hooks: crashOnce() } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    h.session.set("Pack/readme.txt", makeData(100, 2));
    await h.settled();
    const rec = await recover(h);
    expect(rec.committedUnits).toEqual([]);
    expect(rec.resumableFiles).toBe(2);
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    const res = await h.exec();
    expect(res.state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(before);
    expect(names(h.local)).toEqual(["Pack", "Pack/ep.mkv", "Pack/readme.txt"]);
    expect(h.stores.ledger.active(h.jobId).size).toBe(2);
    expect(names(h.local).filter((n) => n.includes("conflict"))).toEqual([]);
    expect(readFileSync(path.join(h.local, "Pack/ep.mkv"), "utf8")).toBe("EXTRACTED-VIDEO");
  });
});
