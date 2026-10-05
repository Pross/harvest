import { afterAll, beforeAll } from "vitest";
import { composeDown, composeUp, dockerAvailable, waitForAll } from "../helpers/compose.js";
import { scanSftpHostKey } from "../helpers/hosts.js";
import { rcloneAvailable, resolveRclone } from "../helpers/rclone.js";
import { wipe } from "../helpers/seed.js";

/** True when docker and rclone are usable. Scenario files use `describe.skipIf(!integrationEnabled())`. */
export const integrationEnabled = (): boolean => dockerAvailable() && rcloneAvailable();

export function rcloneBin(): string {
  const r = resolveRclone();
  if (!r.bin) throw new Error(r.skipReason);
  return r.bin;
}

/**
 * Registers beforeAll/afterAll that bring the compose stack up (idempotent `up -d`) and wipe the shared
 * data volumes, then `down -v` at the end. Vitest isolates modules per file, so every scenario file
 * pays one up/down cycle (about 5 s with cached images); there is no cross-file singleton to rely on.
 */
let sftpKey: string | undefined;
/** The live sftp server's ed25519 key line (set by useStack); runs refuse unpinned sftp hosts, so rigs pin it. */
export function sftpHostKey(): string {
  if (!sftpKey) throw new Error("useStack() has not scanned the sftp host key yet");
  return sftpKey;
}

export function useStack(): void {
  beforeAll(async () => {
    await composeUp();
    await waitForAll();
    await wipe("ftp");
    await wipe("sftp");
    // docker's port proxy accepts connections before sshd listens: bounded retry for the key scan
    for (let i = 0; ; i++) {
      try {
        sftpKey = await scanSftpHostKey();
        break;
      } catch (err) {
        if (i >= 30) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }, 300_000);
  afterAll(async () => {
    await composeDown();
  }, 120_000);
}
