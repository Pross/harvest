import { readdirSync } from "node:fs";
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXCLUDES } from "../../../src/domain.js";
import { fileSha, makeRig, type Target } from "../support/rig.js";
import { integrationEnabled, useStack } from "../support/stack.js";

const TARGETS: Target[] = ["ftp", "sftp"];
const PACK = "Show.S01.1080p";
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const EPISODES = { [`${PACK}/Show.S01E01.mkv`]: 256_000, [`${PACK}/Show.S01E02.mkv`]: 257_000, [`${PACK}/Show.S01E03.mkv`]: 258_000 };

describe.skipIf(!integrationEnabled())("season pack unit", () => {
  useStack();

  describe.each(TARGETS)("%s", (target) => {
    it("promotes the pack as one directory without excluded files, then adds a late episode", async () => {
      const rig = makeRig({ target, job: { unitMode: "top_dir", excludeGlobs: [...DEFAULT_EXCLUDES, "**/*.nfo", "**/Sample/**"] } });
      const seeded = await rig.seed({ ...EPISODES, [`${PACK}/${PACK}.nfo`]: 512, [`${PACK}/Sample/sample.mkv`]: 32_000 });
      const res = await rig.settled();
      expect(res.state).toBe("succeeded");
      expect(res.row).toMatchObject({ filesPlanned: 3, filesOk: 3, filesSkipped: 2 });
      expect(readdirSync(rig.localPath(PACK)).sort()).toEqual(Object.keys(EPISODES).map((p) => p.split("/")[1]).sort());
      expect(await exists(rig.localPath(`${PACK}/Sample`))).toBe(false);
      for (const p of Object.keys(EPISODES)) expect(await fileSha(rig.localPath(p))).toBe(seeded.get(p)!.sha256);
      expect(rig.ledger().map((r) => r.remotePath).sort()).toEqual(Object.keys(EPISODES).sort());
      expect([...rig.stores.ledger.completedUnits(rig.jobId)]).toEqual([PACK]);
      expect(await exists(rig.localPath(`.harvest-staging/${rig.jobId}/${PACK}`))).toBe(false); // the staged dir was renamed away
      expect(await rig.remoteExists(`${PACK}/${PACK}.nfo`)).toBe(true); // excluded files are never touched remotely

      // a late episode lands in the existing directory
      const late = await rig.seed({ [`${PACK}/Show.S01E04.mkv`]: 259_000 });
      const res2 = await rig.settled();
      expect(res2.state).toBe("succeeded");
      expect(res2.row.filesOk).toBe(1);
      expect(await fileSha(rig.localPath(`${PACK}/Show.S01E04.mkv`))).toBe(late.get(`${PACK}/Show.S01E04.mkv`)!.sha256);
      expect(rig.ledger()).toHaveLength(4);
      expect(readdirSync(rig.localPath(PACK))).toHaveLength(4);
    });
  });
});
