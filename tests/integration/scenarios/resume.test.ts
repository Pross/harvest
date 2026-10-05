import { describe, expect, it } from "vitest";
import { recoverPromoting } from "../../../src/run/recovery.js";
import { replaceFile } from "../helpers/seed.js";
import { MIB, fileSha, makeRig, type Rig, type Target } from "../support/rig.js";
import { integrationEnabled, useStack } from "../support/stack.js";

const TARGETS: Target[] = ["ftp", "sftp"];
const SIZE = 6 * MIB + 4321;
const REL = "big/big.bin";
const MARGIN = 64 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bigRig = (target: Target) => makeRig({ target, job: { rangeStreams: 2, parallelFiles: 1 } });

/** Durable bytes recorded for the partial of REL, summed over its ranges (0 when there is no partial). */
function durable(rig: Rig): { sum: number; ranges: number } {
  const row = rig.stores.partials.get(rig.jobId, REL);
  if (!row) return { sum: 0, ranges: 0 };
  const ranges = rig.stores.partials.ranges(row.id);
  return { sum: ranges.reduce((n, r) => n + r.durableBytes, 0), ranges: ranges.length };
}

/** Run 1 sees the file; the clock moves; run 2 is throttled and aborted after ~3 MiB crossed the wire. */
async function startAndAbort(rig: Rig): Promise<void> {
  await rig.runOk();
  rig.clock.t += 120_000;
  rig.control.rate = 1.5 * MIB;
  const ac = new AbortController();
  rig.meter.onBytes = (n) => { if (n >= 3 * MIB) ac.abort(); };
  const res = await rig.run({ signal: ac.signal });
  rig.meter.onBytes = undefined;
  rig.control.rate = null;
  expect(res.state).toBe("cancelled");
}

describe.skipIf(!integrationEnabled())("interrupted transfers", () => {
  useStack();

  describe.each(TARGETS)("%s", (target) => {
    it("abort mid-file, rerun resumes from the durable offsets and the sha256 matches", async () => {
      const rig = bigRig(target);
      const seeded = await rig.seed({ [REL]: SIZE });
      await startAndAbort(rig);
      const d = durable(rig);
      expect(d.ranges).toBe(2);
      expect(d.sum).toBeGreaterThan(MIB);
      expect(d.sum).toBeLessThan(SIZE);
      expect(await rig.remoteExists(REL)).toBe(true);

      rig.meter.bytes = 0;
      const res = await rig.runOk();
      expect(res.state).toBe("succeeded");
      expect(await fileSha(rig.localPath(REL))).toBe(seeded.get(REL)!.sha256);
      expect(rig.meter.bytes).toBeLessThan(SIZE - MIB); // resumed, did not start over
      expect(rig.meter.bytes).toBeLessThanOrEqual(SIZE - d.sum + 2 * MARGIN + 64 * 1024);
      expect(rig.ledger()).toHaveLength(1);
      expect(rig.stores.partials.get(rig.jobId, REL)).toBeUndefined();
    });

    it("hard stop (frozen executor discarded, fresh executor over the same DB and staging dir) resumes", async () => {
      const rig = bigRig(target);
      const seeded = await rig.seed({ [REL]: SIZE });
      await rig.runOk();
      rig.clock.t += 120_000;
      rig.control.rate = 1.5 * MIB;
      rig.control.freezeAfterBytes = 3 * MIB;
      const zombie = new AbortController();
      const zombieRun = rig.run({ signal: zombie.signal });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("transfer never reached 3 MiB")), 60_000);
        rig.meter.onBytes = (n) => { if (n >= 3 * MIB) { clearTimeout(t); resolve(); } };
      });
      await sleep(2000); // the frozen run stops writing; let an in-flight checkpoint land
      rig.meter.onBytes = undefined;
      const d = durable(rig);
      expect(d.sum).toBeGreaterThan(MIB);
      expect(d.sum).toBeLessThan(SIZE);

      // "restart": interrupted runs are failed on boot, promoting partials recovered, a fresh executor is built
      expect(rig.stores.runs.failNonTerminal("interrupted by restart")).toBe(1);
      await recoverPromoting({ stores: rig.stores, logger: (await import("../../../src/logger.js")).buildLogger("silent", false) });
      rig.control.rate = null;
      rig.control.freezeAfterBytes = null;
      rig.rebuild();
      rig.meter.bytes = 0;
      const res = await rig.runOk();
      zombie.abort();
      await zombieRun;
      expect(res.state).toBe("succeeded");
      expect(await fileSha(rig.localPath(REL))).toBe(seeded.get(REL)!.sha256);
      expect(rig.meter.bytes).toBeLessThan(SIZE - MIB);
      expect(rig.ledger()).toHaveLength(1);
    });

    it("remote replaced between attempts (new mtime): partial discarded, final content is the new file", async () => {
      const rig = bigRig(target);
      await rig.seed({ [REL]: SIZE });
      await startAndAbort(rig);
      const oldPartial = rig.stores.partials.get(rig.jobId, REL);
      expect(oldPartial).toBeDefined();
      expect(durable(rig).sum).toBeGreaterThan(MIB);

      await sleep(1100); // mtime has one-second resolution on sftp and ftp
      const fresh = await replaceFile(rig.service, `${rig.dir}/${REL}`, "replacement", SIZE);
      rig.clock.t += 120_000;
      const unsettled = await rig.runOk(); // the changed file restarts its settle clock
      expect(unsettled.row.filesOk).toBe(0);
      rig.clock.t += 120_000;
      rig.meter.bytes = 0;
      const res = await rig.runOk();
      expect(res.state).toBe("succeeded");
      expect(await fileSha(rig.localPath(REL))).toBe(fresh.sha256);
      expect(rig.meter.bytes).toBeGreaterThanOrEqual(SIZE); // whole new file fetched, nothing reused
      expect(rig.ledger()).toHaveLength(1);
    });
  });
});
