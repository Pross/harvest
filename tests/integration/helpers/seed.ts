import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compose, exec, type Service } from "./compose.js";

/** Remote data root per service (as seen from inside the container). */
export const REMOTE_ROOT: Record<Service, string> = {
  ftp: "/srv/ftp",
  "ftps-explicit": "/srv/ftp",
  "ftps-implicit": "/srv/ftp",
  sftp: "/home/testuser/data",
};

/** Deterministic pseudo-random bytes: sha256 counter mode keyed by seed. Same (seed, size) -> same bytes. */
export function pseudoRandom(seed: string, size: number): Buffer {
  const out = Buffer.allocUnsafe(size);
  let off = 0;
  for (let i = 0; off < size; i++) {
    const block = createHash("sha256").update(`${seed}:${i}`).digest();
    off += block.copy(out, off, 0, Math.min(32, size - off));
  }
  return out;
}

export const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export type SeededFile = { path: string; size: number; sha256: string };

/** Copy `content` to `<root>/<relPath>` inside the service and open permissions for all server users. */
export async function putFile(service: Service, relPath: string, content: Buffer): Promise<SeededFile> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harvest-seed-"));
  try {
    const local = path.join(dir, "f");
    await writeFile(local, content);
    const remote = `${REMOTE_ROOT[service]}/${relPath}`;
    await exec(service, ["mkdir", "-p", path.posix.dirname(remote)]);
    await compose(["cp", local, `${service}:${remote}`], 120_000);
    await exec(service, ["chmod", "-R", "a+rwX", REMOTE_ROOT[service]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { path: relPath, size: content.length, sha256: sha256(content) };
}

/** Seed files of given sizes with deterministic content; returns the sha256 per file. */
export async function seedFiles(service: Service, files: Record<string, number>): Promise<SeededFile[]> {
  const out: SeededFile[] = [];
  for (const [rel, size] of Object.entries(files)) out.push(await putFile(service, rel, pseudoRandom(rel, size)));
  return out;
}

/** Season pack: `<dir>/<name>.SxxEyy.mkv` episodes, `<dir>/<dir>.nfo`, and `<dir>/Sample/sample.mkv`. */
export async function seedSeasonPack(service: Service, dir = "Show.S01.1080p", episodes = 3, episodeBytes = 256 * 1024): Promise<SeededFile[]> {
  const files: Record<string, number> = {};
  for (let e = 1; e <= episodes; e++) files[`${dir}/Show.S01E${String(e).padStart(2, "0")}.mkv`] = episodeBytes + e * 1000;
  files[`${dir}/${dir}.nfo`] = 512;
  files[`${dir}/Sample/sample.mkv`] = 32 * 1024;
  return seedFiles(service, files);
}

export async function deleteFile(service: Service, relPath: string): Promise<void> {
  await exec(service, ["rm", "-rf", `${REMOTE_ROOT[service]}/${relPath}`]);
}

/** Replace a file with new content (new mtime), e.g. to test "remote changed between attempts". */
export async function replaceFile(service: Service, relPath: string, seed: string, size: number): Promise<SeededFile> {
  await deleteFile(service, relPath);
  return putFile(service, relPath, pseudoRandom(seed, size));
}

/** Remove everything under the data root (keeps the root itself). */
export async function wipe(service: Service): Promise<void> {
  const root = REMOTE_ROOT[service];
  await exec(service, ["sh", "-c", `find ${root} -mindepth 1 -delete`]);
}

/** Seed many files with one `compose cp` and one chmod (much faster than repeated putFile). `files` maps relPath -> content. */
export async function putTree(service: Service, files: Record<string, Buffer>): Promise<SeededFile[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harvest-tree-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const local = path.join(dir, rel);
      await mkdir(path.dirname(local), { recursive: true });
      await writeFile(local, content);
    }
    const root = REMOTE_ROOT[service];
    await compose(["cp", `${dir}/.`, `${service}:${root}/`], 120_000);
    await exec(service, ["chmod", "-R", "a+rwX", root]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return Object.entries(files).map(([rel, c]) => ({ path: rel, size: c.length, sha256: sha256(c) }));
}
