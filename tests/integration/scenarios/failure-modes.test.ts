import { describe, expect, it } from "vitest";
import { AuthError, HostKeyChanged, TransientNetwork } from "../../../src/errors.js";
import { fileSha, makeRig, randomHostKeyLine, type Rig, type Target } from "../support/rig.js";
import { integrationEnabled, sftpHostKey, useStack } from "../support/stack.js";

const TARGETS: Target[] = ["ftp", "sftp"];
const WRONG = "definitely-wrong-pw-9917";

/** Everything a user or log reader could see for a run: activity (summary + meta), run error, captured logs. */
function visibleText(rig: Rig, runId: number): string {
  const row = rig.stores.runs.get(runId)!;
  const act = rig.activity().map((a) => `${a.summary} ${JSON.stringify(a.meta)}`);
  return [row.error ?? "", ...act, ...rig.logLines].join("\n");
}
const fatalFlags = (rig: Rig): unknown[] => rig.activity().filter((a) => a.category === "run" && a.severity === "error").map((a) => (a.meta as { fatal?: boolean }).fatal);

describe.skipIf(!integrationEnabled())("failure modes", () => {
  useStack();

  describe.each(TARGETS)("%s", (target) => {
    it("wrong password: run fails and no secret appears in activity, run error or logs", async () => {
      const rig = makeRig({ target, host: { secret: { password: WRONG } } });
      await rig.seed({ "a.txt": 1000 });
      const res = await rig.run();
      expect(res.state).toBe("failed");
      const text = visibleText(rig, res.runId);
      expect(text).toContain("Run failed");
      expect(text).not.toContain(WRONG);
      expect(text).not.toContain("testpass");
      expect(text).not.toMatch(/RCLONE_CONFIG_\w*PASS/);
      expect(rig.localFiles()).toEqual([]);
      expect(rig.meter.bytes).toBe(0);
    });

    it("wrong password: AuthError-class outcome (typed error and fatal run failure)", async () => {
      const rig = makeRig({ target, host: { secret: { password: WRONG } } });
      const session = await rig.engine.open(rig.stores.hosts.getConfig(rig.hostId));
      await expect(session.list(rig.remoteRoot, { recurse: true })).rejects.toBeInstanceOf(AuthError);
      await rig.run();
      expect(fatalFlags(rig)).toEqual([true]); // fatal = AuthError or HostKeyChanged: never retried
    });

    it("unreachable port: TransientNetwork-class failure within a bounded time, nothing downloaded", { timeout: 90_000 }, async () => {
      const rig = makeRig({ target, host: { port: target === "ftp" ? 2199 : 2299 } });
      const session = await rig.engine.open(rig.stores.hosts.getConfig(rig.hostId));
      const started = Date.now();
      await expect(session.list(rig.remoteRoot, { recurse: true })).rejects.toBeInstanceOf(TransientNetwork);
      const res = await rig.run();
      expect(res.state).toBe("failed");
      expect(fatalFlags(rig)).toEqual([false]);
      expect(res.row.error).toMatch(/refused|timed out|unreachable/i);
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(rig.meter.bytes).toBe(0);
    });
  });

  it("sftp: a pinned host key that does not match gives HostKeyChanged, nothing is downloaded", async () => {
    const rig = makeRig({ target: "sftp", hostKeys: randomHostKeyLine() });
    await rig.seed({ "a.txt": 1000 });
    const session = await rig.engine.open(rig.stores.hosts.getConfig(rig.hostId));
    await expect(session.list(rig.remoteRoot, { recurse: true })).rejects.toBeInstanceOf(HostKeyChanged);
    await rig.run();
    const res = await rig.settled();
    expect(res.state).toBe("failed");
    expect(rig.activity().some((a) => a.category === "host-key" && a.severity === "error")).toBe(true);
    expect(fatalFlags(rig).every((f) => f === true)).toBe(true);
    expect(rig.localFiles()).toEqual([]);
    expect(rig.meter.bytes).toBe(0);
    expect(rig.ledger()).toHaveLength(0);
  });

  it("sftp: the correct pinned key (control) and key auth both work", async () => {
    for (const target of ["sftp", "sftp-key"] as const) {
      const rig = makeRig({ target, hostKeys: sftpHostKey() });
      const seeded = await rig.seed({ "a.txt": 1000 });
      expect((await rig.settled()).state).toBe("succeeded");
      expect(await fileSha(rig.localPath("a.txt"))).toBe(seeded.get("a.txt")!.sha256);
    }
  });
});
