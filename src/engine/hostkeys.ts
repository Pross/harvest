import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { ScannedHostKey } from "./types.js";
import { PermanentError, TransientNetwork } from "../errors.js";

/** Runs a command and resolves with its stdout. Injectable so tests need no network. */
export type Exec = (cmd: string, args: string[]) => Promise<string>;

export const MAX_RCLONE_HOST_KEYS = 16;

export const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 20, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** `SHA256:` + unpadded base64 of sha256(decoded key), the same string `ssh-keygen -lf` prints. */
export function fingerprint(base64Key: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** Parses `ssh-keyscan` stdout (`host algo base64` lines, `#` comments skipped), de-duplicated. */
export function parseKeyScan(output: string): ScannedHostKey[] {
  const seen = new Set<string>();
  const keys: ScannedHostKey[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [, type, b64] = line.split(/\s+/);
    if (!type || !b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) continue;
    const keyLine = `${type} ${b64}`;
    if (seen.has(keyLine)) continue;
    seen.add(keyLine);
    keys.push({ type, line: keyLine, sha256: fingerprint(b64) });
  }
  return keys;
}

export async function scanHostKeys(
  host: string,
  port: number,
  opts: { timeoutSec: number; exec?: Exec },
): Promise<ScannedHostKey[]> {
  if (host.startsWith("-")) throw new PermanentError(`invalid host name: ${host}`);
  const args = ["-T", String(opts.timeoutSec), "-p", String(port), host];
  let out: string;
  try {
    out = await (opts.exec ?? defaultExec)("ssh-keyscan", args);
  } catch (err) {
    throw new TransientNetwork(`ssh-keyscan failed for ${host}:${port}`, { cause: err });
  }
  const keys = parseKeyScan(out);
  if (keys.length === 0) throw new TransientNetwork(`ssh-keyscan returned no host keys for ${host}:${port}`);
  return keys;
}

/**
 * Value for rclone's `host_keys` option (env `RCLONE_CONFIG_H<id>_HOST_KEYS`).
 * Verified (C1): comma-separated `<algo> <base64>` entries only (no comments, host column or newlines);
 * any entry matching the offered key passes; more than 16 entries is a hard parse error, hence the cap.
 */
export function toRcloneHostKeys(keys: ScannedHostKey[]): string {
  return keys.slice(0, MAX_RCLONE_HOST_KEYS).map((k) => k.line).join(",");
}

/** Accepts stored key lines separated by newlines or commas and returns the rclone option value. */
export function normalizeStoredHostKeys(stored: string): string {
  const lines = stored.split(/[\n,]/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  return lines.slice(0, MAX_RCLONE_HOST_KEYS).join(",");
}
