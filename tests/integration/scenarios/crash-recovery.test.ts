import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLogger } from "../../../src/logger.js";
import { recoverPromoting } from "../../../src/run/recovery.js";
import { fileSha, makeRig, type Target } from "../support/rig.js";
import { integrationEnabled, useStack } from "../support/stack.js";

function walk(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return statSync(path.join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });
}

const CASES: Array<[Target, "top_dir" | "file"]> = [["ftp", "top_dir"], ["sftp", "top_dir"], ["ftp", "file"], ["sftp", "file"]];

describe.skipIf(!integrationEnabled())("crash between rename and ledger commit", () => {
  useStack();

  it.each(CASES)("%s (%s): recoverPromoting commits the ledger; rerun has no conflict file and no re-download", async (target, unitMode) => {
    let boom = true;
    const rig = makeRig({
      target, job: { unitMode },
      deps: { hooks: { afterRename: () => { if (boom) throw new Error("simulated crash after rename"); } } },
    });
    const files: Record<string, number> = unitMode === "top_dir" ? { "pack/x.bin": 50_000, "pack/y.bin": 60_000 } : { "x.bin": 50_000 };
    const seeded = await rig.seed(files);
    const crashed = await rig.settled();
    expect(crashed.state).toBe("failed");
    expect(rig.ledger()).toHaveLength(0); // the commit never happened
    expect(rig.stores.partials.listPromoting()).toHaveLength(Object.keys(files).length);
    for (const [rel, f] of seeded) expect(await fileSha(rig.localPath(rel))).toBe(f.sha256); // but the rename did

    boom = false;
    rig.rebuild();
    const recovered = await recoverPromoting({ stores: rig.stores, logger: buildLogger("silent", false) });
    expect(recovered.committedUnits).toEqual([unitMode === "top_dir" ? "pack" : "x.bin"]);
    expect(recovered.discardedFiles).toBe(0);
    expect(rig.ledger().map((r) => r.remotePath).sort()).toEqual(Object.keys(files).sort());
    expect(rig.stores.partials.listPromoting()).toHaveLength(0);

    const bytes = rig.meter.bytes;
    const opens = rig.meter.opens;
    const res = await rig.runOk();
    expect(res.state).toBe("succeeded");
    expect(rig.meter.bytes).toBe(bytes);
    expect(rig.meter.opens).toBe(opens);
    expect(walk(rig.local).filter((p) => p.includes(".harvest-conflict"))).toEqual([]);
    for (const [rel, f] of seeded) {
      expect(await fileSha(rig.localPath(rel))).toBe(f.sha256);
      expect(await rig.remoteExists(rel)).toBe(true);
    }
  });
});
