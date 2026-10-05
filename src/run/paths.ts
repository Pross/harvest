import { promises as fsp } from "node:fs";
import path from "node:path";
import { PermanentError } from "../errors.js";

export const STAGING_DIR = ".harvest-staging";

/** Staging root of a job: `<localPath>/.harvest-staging/<jobId>`. Keyed by job so partials resume across runs. */
export function stagingRoot(localPath: string, jobId: number): string {
  return path.join(localPath, STAGING_DIR, String(jobId));
}

export function stagingPathFor(localPath: string, jobId: number, remotePath: string): string {
  return path.join(stagingRoot(localPath, jobId), ...remotePath.split("/"));
}

export function finalPathFor(localPath: string, remotePath: string): string {
  return path.join(localPath, ...remotePath.split("/"));
}

/** Absolute remote path handed to the engine session. */
export function remoteAbsFor(jobRemotePath: string, remotePath: string): string {
  return path.posix.join(jobRemotePath, remotePath);
}

/** Absolute remote path of a planned file for engine calls: the server's own spelling (`remoteRaw`) when it differs from the NFC key. */
export function remoteAbsOf(jobRemotePath: string, file: { remotePath: string; remoteRaw?: string }): string {
  return remoteAbsFor(jobRemotePath, file.remoteRaw ?? file.remotePath);
}

/** Throws unless `target` is strictly below `root` (after lexical resolution). */
export function assertContained(root: string, target: string): void {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (!t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) {
    throw new PermanentError(`path escapes its root: ${target} is not below ${root}`);
  }
}

export type SameDevice = (a: string, b: string) => Promise<boolean>;

export const defaultSameDevice: SameDevice = async (a, b) => (await fsp.stat(a)).dev === (await fsp.stat(b)).dev;

/** Creates the staging root and refuses to run when a rename into localPath would be a cross-device copy. */
export async function ensureStaging(localPath: string, jobId: number, sameDevice: SameDevice = defaultSameDevice): Promise<string> {
  const root = stagingRoot(localPath, jobId);
  await fsp.mkdir(root, { recursive: true });
  if (!(await sameDevice(root, localPath))) {
    throw new PermanentError(`staging directory ${root} is on a different filesystem than ${localPath}; rename would be a copy`);
  }
  return root;
}

/** Final and staging paths for one remote-relative path, both containment-checked. */
export function resolvePaths(localPath: string, jobId: number, remotePath: string): { staging: string; final: string } {
  const staging = stagingPathFor(localPath, jobId, remotePath);
  const final = finalPathFor(localPath, remotePath);
  assertContained(stagingRoot(localPath, jobId), staging);
  assertContained(localPath, final);
  return { staging, final };
}

/**
 * Containment of the REAL destination: the real path of the deepest existing ancestor of `target`'s parent
 * directory must stay inside the real `root`, so a pre-existing symlink like `<root>/Show -> /elsewhere`
 * is never followed. A dangling symlink on the way is refused as well.
 */
export async function assertRealContained(root: string, target: string): Promise<void> {
  const realRoot = await fsp.realpath(root);
  for (let cur = path.dirname(path.resolve(target)); ; ) {
    try {
      const real = await fsp.realpath(cur);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        throw new PermanentError(`destination resolves outside the local path through a symlink: ${target} -> ${real}`);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (await fsp.lstat(cur).then(() => true, () => false)) throw new PermanentError(`dangling symlink in destination path: ${cur}`);
      const up = path.dirname(cur);
      if (up === cur) throw err;
      cur = up;
    }
  }
}
