import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { MIB, fileSha, makeRig } from "../support/rig.js";
import { integrationEnabled, useStack } from "../support/stack.js";

/** vsftpd (implicit) restarts after every session: keep parallelism at 1 and retry bounded. */
const IMPLICIT = { job: { rangeStreams: 1, parallelFiles: 1, retries: 6 }, attempts: 8 };

describe.skipIf(!integrationEnabled())("FTPS", () => {
  useStack();

  it("explicit: happy path with a multi-range file and after_sync delete, then local delete is not re-fetched", async () => {
    const rig = makeRig({ target: "ftps-explicit", job: { afterSync: "delete" } });
    const seeded = await rig.seed({ "a.txt": 1500, "big/big.bin": 3 * MIB + 99 });
    const res = await rig.settled();
    expect(res.state).toBe("succeeded");
    for (const [rel, f] of seeded) {
      expect(await fileSha(rig.localPath(rel))).toBe(f.sha256);
      expect(await rig.remoteExists(rel)).toBe(false);
    }
    expect(rig.ledger()).toHaveLength(2);
    expect(rig.meter.opens).toBeGreaterThanOrEqual(5);
    rmSync(rig.localPath("a.txt"));
    const before = rig.meter.opens;
    expect((await rig.runOk()).state).toBe("succeeded");
    expect(rig.meter.opens).toBe(before);
  });

  it("implicit: happy path (small and multi-MiB file), ledger rows, remote kept", { timeout: 180_000 }, async () => {
    const rig = makeRig({ target: "ftps-implicit", job: IMPLICIT.job });
    const seeded = await rig.seed({ "a.txt": 1500, "big/big.bin": 3 * MIB + 99 });
    const res = await rig.settled(IMPLICIT.attempts);
    expect(res.state).toBe("succeeded");
    for (const [rel, f] of seeded) {
      expect(await fileSha(rig.localPath(rel))).toBe(f.sha256);
      expect(await rig.remoteExists(rel)).toBe(true);
    }
    expect(rig.ledger()).toHaveLength(2);
  });

  it("implicit: a self-signed certificate is rejected unless the host accepts it", { timeout: 120_000 }, async () => {
    const rig = makeRig({ target: "ftps-implicit", host: { tlsAcceptSelfSigned: false }, job: IMPLICIT.job });
    await rig.seed({ "a.txt": 1500 });
    let res = await rig.run();
    for (let i = 0; i < 4 && !/certificate|x509|tls/i.test(res.row.error ?? ""); i++) res = await rig.run(); // skip vsftpd restart gaps
    expect(res.state).toBe("failed");
    expect(res.row.error).toMatch(/certificate|x509|tls/i);
    expect(rig.meter.bytes).toBe(0);
    expect(rig.ledger()).toHaveLength(0);
  });
});
