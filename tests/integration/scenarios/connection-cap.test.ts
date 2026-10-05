import { describe, expect, it } from "vitest";
import { MIB, fileSha, makeRig, type Target } from "../support/rig.js";
import { integrationEnabled, useStack } from "../support/stack.js";

const TARGETS: Target[] = ["ftp", "sftp"];

describe.skipIf(!integrationEnabled())("host connection cap", () => {
  useStack();

  describe.each(TARGETS)("%s", (target) => {
    it("max_connections 2 with a file wanting 4 ranges shrinks and completes without hanging", { timeout: 90_000 }, async () => {
      const rig = makeRig({ target, host: { maxConnections: 2 }, job: { rangeStreams: 4, parallelFiles: 2 }, cfg: { rangeMinBytes: MIB } });
      const seeded = await rig.seed({ "big.bin": 3 * MIB + 777, "small.txt": 900 });
      const res = await rig.settled();
      expect(res.state).toBe("succeeded");
      expect(await fileSha(rig.localPath("big.bin"))).toBe(seeded.get("big.bin")!.sha256);
      expect(await fileSha(rig.localPath("small.txt"))).toBe(seeded.get("small.txt")!.sha256);
      // cap 2 reserves one slot for list/stat/delete, so at most one transfer connection: one open per file
      expect(rig.meter.opens).toBe(2);
    });
  });
});
