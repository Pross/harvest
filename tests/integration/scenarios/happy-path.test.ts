/*
 * Harvest integration scenarios (README)
 *
 * What: end-to-end scenarios of the REAL run executor over the REAL RcloneEngine against the docker servers in
 * docker-compose.test.yml (pure-ftpd plain + explicit FTPS, vsftpd implicit FTPS, atmoz/sftp with password + key),
 * with an in-memory SQLite DB (real stores) and a temp local dir. Nothing is faked except the clock and a
 * byte-metering wrapper around the engine session (tests/integration/support/rig.ts).
 *
 * Run (needs docker and rclone; the repo copy is picked up from <repo>/.tools/rclone, or set RCLONE_BIN):
 *   RCLONE_BIN=$PWD/.tools/rclone npx vitest run --config vitest.integration.config.ts
 * Each file brings the stack up in beforeAll and runs `down -v` in afterAll (about 5 s with cached images).
 * Files run serially (fileParallelism false) because they share fixed host ports.
 *
 * Quirks:
 *  - The first run only records a sighting (settle clock), so scenarios use rig.settled(): run, advance the fake
 *    clock past settleSeconds, run again. The fake clock starts at Date.now() because remote mtimes are real.
 *  - vsftpd (implicit FTPS) segfaults after a session and restarts in a loop: connects can be refused for about
 *    0.3 s, so those scenarios use rig.runOk(attempts) / low parallelism and a bounded retry.
 *  - sftp users are chrooted: remote paths are /data/<dir>; FTP remote paths are /<dir>.
 *  - A throttle (rig.control.rate) slows transfers so aborts and freezes land mid-file deterministically.
 */
import { describe, expect, it } from "vitest";
import { MIB, fileSha, makeRig, type Target } from "../support/rig.js";
import { integrationEnabled, useStack } from "../support/stack.js";

const TARGETS: Target[] = ["ftp", "sftp", "sftp-key"];
const FILES = { "a.txt": 1000, "big/big.bin": 5 * MIB + 12_345 };

describe.skipIf(!integrationEnabled())("happy path", () => {
  useStack();

  describe.each(TARGETS)("%s", (target) => {
    it("downloads files, writes ledger rows and counters, keeps the remote (after_sync keep)", async () => {
      const rig = makeRig({ target, job: { afterSync: "keep" } });
      const seeded = await rig.seed(FILES);
      const first = await rig.runOk();
      expect(first.state).toBe("succeeded");
      expect(rig.ledger()).toHaveLength(0); // first sighting transfers nothing
      rig.clock.t += 120_000;
      const res = await rig.runOk();
      expect(res.state).toBe("succeeded");
      for (const [rel, f] of seeded) expect(await fileSha(rig.localPath(rel))).toBe(f.sha256);
      const total = [...seeded.values()].reduce((n, f) => n + f.size, 0);
      expect(res.row).toMatchObject({ filesPlanned: 2, filesOk: 2, filesFailed: 0, bytesTotal: total, bytesDone: total });
      const rows = rig.ledger();
      expect(rows.map((r) => r.remotePath).sort()).toEqual(Object.keys(FILES).sort());
      for (const r of rows) expect(r).toMatchObject({ size: seeded.get(r.remotePath)!.size, remoteAction: "none", runId: res.runId });
      expect(rig.meter.opens).toBeGreaterThanOrEqual(5); // 1 + 4 ranges for the multi-range file
      for (const rel of Object.keys(FILES)) expect(await rig.remoteExists(rel)).toBe(true);
      expect(rig.stores.partials.listPromoting()).toHaveLength(0);
      // a third run has nothing to do and downloads nothing
      const before = rig.meter.bytes;
      expect((await rig.runOk()).state).toBe("succeeded");
      expect(rig.meter.bytes).toBe(before);
    });

    it("deletes the remote files only after verify and ledger commit (after_sync delete)", async () => {
      const rig = makeRig({ target, job: { afterSync: "delete" } });
      const seeded = await rig.seed(FILES);
      const res = await rig.settled();
      expect(res.state).toBe("succeeded");
      for (const [rel, f] of seeded) {
        expect(await fileSha(rig.localPath(rel))).toBe(f.sha256);
        expect(await rig.remoteExists(rel)).toBe(false);
      }
      for (const r of rig.ledger()) expect(r.remoteAction).toBe("done");
      expect(rig.ledger()).toHaveLength(2);
    });
  });
});
