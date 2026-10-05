import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { growFile } from "../helpers/grow.js";
import { fileSha, makeRig, type Target } from "../support/rig.js";
import { integrationEnabled, useStack } from "../support/stack.js";
import { access } from "node:fs/promises";

const TARGETS: Target[] = ["ftp", "sftp"];
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

describe.skipIf(!integrationEnabled())("ledger and growing files", () => {
  useStack();

  describe.each(TARGETS)("%s", (target) => {
    it("a deleted local file is not downloaded again, a new remote file is", async () => {
      const rig = makeRig({ target });
      const seeded = await rig.seed({ "a.txt": 2000, "b.txt": 3000 });
      expect((await rig.settled()).state).toBe("succeeded");
      expect(await fileSha(rig.localPath("a.txt"))).toBe(seeded.get("a.txt")!.sha256);
      rmSync(rig.localPath("a.txt"));

      const added = await rig.seed({ "c.txt": 4000 });
      const opensBefore = rig.meter.opens;
      const res = await rig.settled();
      expect(res.state).toBe("succeeded");
      expect(await exists(rig.localPath("a.txt"))).toBe(false);
      expect(await fileSha(rig.localPath("c.txt"))).toBe(added.get("c.txt")!.sha256);
      expect(await fileSha(rig.localPath("b.txt"))).toBe(seeded.get("b.txt")!.sha256);
      expect(rig.meter.opens).toBe(opensBefore + 1); // only c.txt was fetched
      expect(rig.ledger().map((r) => r.remotePath).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
      expect(res.row.filesOk).toBe(1);
    });

    it("a file that keeps growing is not transferred until it settles, then transfers once", async () => {
      const rig = makeRig({ target, job: { settleSeconds: 600 } });
      await rig.seed({ "grow/g.bin": 100_000 });
      expect((await rig.runOk()).state).toBe("succeeded"); // first sighting
      for (let round = 0; round < 2; round++) {
        const g = growFile(rig.service, `${rig.dir}/grow/g.bin`, 50_000, 500, 1000);
        await new Promise((r) => setTimeout(r, 1100));
        await g.stop();
        expect(g.appended()).toBeGreaterThan(0);
        rig.clock.t += 300_000;
        const res = await rig.runOk();
        expect(res.state).toBe("succeeded");
        expect(res.row.filesOk).toBe(0);
        expect(rig.meter.bytes).toBe(0);
        expect(await exists(rig.localPath("grow/g.bin"))).toBe(false);
        expect(rig.ledger()).toHaveLength(0);
      }
      rig.clock.t += 700_000; // growth stopped; the last change is now older than settleSeconds
      const done = await rig.runOk();
      expect(done.state).toBe("succeeded");
      expect(done.row.filesOk).toBe(1);
      const remote = await rig.remoteSha("grow/g.bin");
      expect(await fileSha(rig.localPath("grow/g.bin"))).toBe(remote);
      expect(rig.ledger()).toHaveLength(1);
      const bytes = rig.meter.bytes;
      expect((await rig.runOk()).state).toBe("succeeded");
      expect(rig.meter.bytes).toBe(bytes); // transferred once
    });
  });
});
