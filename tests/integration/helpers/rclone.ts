import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_RCLONE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.tools/rclone");

export type RcloneResolution = { bin: string; skipReason?: undefined } | { bin?: undefined; skipReason: string };

/** `RCLONE_BIN` env, else `<repo>/.tools/rclone`, else `rclone` on PATH, else a skip reason telling the test why. */
export function resolveRclone(): RcloneResolution {
  const candidates = [process.env.RCLONE_BIN, REPO_RCLONE, "rclone"].filter((c): c is string => !!c);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["version"], { timeout: 10_000, encoding: "utf8" });
    if (r.status === 0) return { bin };
  }
  return { skipReason: "rclone not found: set RCLONE_BIN or put rclone (v1.75.x) on PATH; rclone-dependent tests skipped" };
}

export const rcloneAvailable = (): boolean => resolveRclone().bin !== undefined;
