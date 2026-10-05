import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLogger } from "../../src/logger.js";
import type { ExtractInput, PostPipeline } from "../../src/post/types.js";
import { recoverPromoting } from "../../src/run/recovery.js";
import { makeData } from "../helpers/fake-session.js";
import { makeHarness } from "./executor-harness.js";

/** Every *.zip "contains" ep.mkv (15 bytes), written next to it. `warn` makes the step report a warning as well. */
function post(over: Partial<PostPipeline> = {}, warn?: string, drop = false): PostPipeline {
  const extractInStaging = vi.fn(async (i: ExtractInput) => {
    const added: string[] = [];
    const zips = i.files.filter((f) => f.endsWith(".zip"));
    for (const z of zips) {
      const out = path.join(path.dirname(z), "ep.mkv");
      await fsp.writeFile(out, "EXTRACTED-VIDEO");
      added.push(out);
    }
    return { warnings: warn ? [warn] : [], added, removed: drop ? zips : [] };
  });
  return { extractInStaging, afterPromote: async () => ({ warnings: [] }), afterRun: async () => ({ warnings: [] }), ...over };
}

const names = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((n) => !n.startsWith(".harvest-staging")).sort();
const stagingNames = (dir: string): string[] => readdirSync(path.join(dir, ".harvest-staging"), { recursive: true, encoding: "utf8" }).sort();
const remoteAction = (h: ReturnType<typeof makeHarness>) =>
  (h.db.prepare("SELECT remote_action AS a FROM ledger WHERE job_id = ?").all(h.jobId) as { a: string }[]).map((r) => r.a);

describe("promote order and extras journal", () => {
  it("places extras before the staged archive: a crash in between leaves the archive staged and re-extraction is idempotent", async () => {
    let armed = true;
    const hooks = { afterExtras: () => { if (armed) { armed = false; throw new Error("crash"); } } };
    const h = makeHarness({ deps: { post: post({}, undefined, true), hooks } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    h.session.set("Pack/readme.txt", makeData(100, 2));
    await h.settled();
    expect(names(h.local)).toEqual(["Pack", "Pack/ep.mkv"]);
    expect(stagingNames(h.local).some((n) => n.endsWith("a.zip"))).toBe(true);
    expect(h.stores.ledger.active(h.jobId).size).toBe(0);
    const rec = await recoverPromoting({ stores: h.stores, logger: buildLogger("silent", false) });
    expect(rec.committedUnits).toEqual([]);
    expect(rec.resumableFiles).toBe(2);
    const before = h.session.ranged.bytes;
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(h.session.ranged.bytes).toBe(before);
    expect(names(h.local)).toEqual(["Pack", "Pack/ep.mkv", "Pack/readme.txt"]);
    expect(h.stores.ledger.active(h.jobId).size).toBe(2);
    expect(readdirSync(h.local, { recursive: true, encoding: "utf8" }).filter((n) => n.includes("conflict"))).toEqual([]);
    expect(existsSync(path.join(h.local, ".harvest-staging", String(h.jobId), ".harvest-extras.json"))).toBe(false);
  });

  it("a crash right after journaling (before any extra moved) is also recoverable without conflicts", async () => {
    let armed = true;
    const h = makeHarness({ deps: { post: post({}, undefined, true), hooks: { afterJournal: () => { if (armed) { armed = false; throw new Error("crash"); } } } } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    h.session.set("Pack/readme.txt", makeData(100, 2));
    await h.settled();
    expect(existsSync(path.join(h.local, ".harvest-staging", String(h.jobId), ".harvest-extras.json"))).toBe(true);
    await recoverPromoting({ stores: h.stores, logger: buildLogger("silent", false) });
    h.clock.t += 5000;
    expect((await h.exec()).state).toBe("succeeded");
    expect(names(h.local)).toEqual(["Pack", "Pack/ep.mkv", "Pack/readme.txt"]);
  });

  it("moves an unrelated same-size local file aside instead of replacing it, with a warning", async () => {
    const h = makeHarness({ deps: { post: post() } });
    mkdirSync(path.join(h.local, "Pack"));
    writeFileSync(path.join(h.local, "Pack/ep.mkv"), "SOMEONE-ELSES-15");
    writeFileSync(path.join(h.local, "Pack/ep2.mkv"), "x");
    h.session.set("Pack/a.zip", makeData(3000, 1));
    await h.settled();
    const all = readdirSync(path.join(h.local, "Pack"));
    const conflict = all.find((n) => n.startsWith("ep.mkv.harvest-conflict-"));
    expect(conflict).toBeDefined();
    expect(readFileSync(path.join(h.local, "Pack", conflict!), "utf8")).toBe("SOMEONE-ELSES-15");
    expect(readFileSync(path.join(h.local, "Pack/ep.mkv"), "utf8")).toBe("EXTRACTED-VIDEO");
    expect(h.activity().some((a) => a.category === "conflict" && a.severity === "warn")).toBe(true);
  });
});

describe("remote after_sync action when extraction did not succeed", () => {
  it.each([
    ["reports a warning", post({}, "a.zip: Wrong password")],
    ["throws", post({ extractInStaging: async () => { throw new Error("pipeline bug"); } })],
  ])("is skipped for the unit when extraction %s", async (_n, p) => {
    const h = makeHarness({ deps: { post: p }, job: { afterSync: "delete" } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    const res = await h.settled();
    expect(res.state).toBe("partial");
    expect(h.session.removed).toEqual([]);
    expect(h.session.files.has("/remote/Pack/a.zip")).toBe(true);
    expect(remoteAction(h)).toEqual(["none"]);
    expect(h.activity().some((a) => a.category === "remote-action" && a.severity === "warn" && a.summary.includes("skipped") && a.summary.includes("Pack"))).toBe(true);
  });

  it("still deletes the remote file when extraction succeeded cleanly", async () => {
    const h = makeHarness({ deps: { post: post() }, job: { afterSync: "delete" } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    await h.settled();
    expect(h.session.removed).toEqual(["/remote/Pack/a.zip"]);
  });

  it("is skipped for move and delete_after_days too (ledger stays none)", async () => {
    const h = makeHarness({ deps: { post: post({}, "boom") }, job: { afterSync: "delete_after_days", afterDays: 1 } });
    h.session.set("Pack/a.zip", makeData(3000, 1));
    await h.settled();
    expect(remoteAction(h)).toEqual(["none"]);
  });
});
