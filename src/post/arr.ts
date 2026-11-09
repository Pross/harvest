import { existsSync } from "node:fs";
import path from "node:path";
import type { ArrConfig } from "../store/arr-store.js";
import type { Logger } from "../logger.js";
import type { Stores } from "../store/index.js";
import { explainError } from "./explain.js";
import { IntegrationHttpError, httpRequest, joinUrl } from "./http.js";
import type { AfterDeleteInput, AfterDeleteStep, AfterPromoteInput, AfterPromoteStep, PostResult } from "./types.js";

const COMMAND = { sonarr: "DownloadedEpisodesScan", radarr: "DownloadedMoviesScan" } as const;

type ArrStores = Pick<Stores, "arrTargets" | "integrations">;

/** Deepest directory that contains every file (one scan per unit, not per file). */
export function commonDir(files: string[]): string | null {
  const dirs = files.map((f) => path.dirname(f).split(path.sep));
  const first = dirs[0];
  if (!first) return null;
  let n = first.length;
  for (const d of dirs) {
    let i = 0;
    while (i < n && i < d.length && d[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join(path.sep) || path.sep;
}

/** Replaces the job.localPath prefix of `dir` with the folder as the *arr container sees it. Null when dir is outside localPath. */
export function mapToArrPath(localPath: string, arrPath: string, dir: string): string | null {
  const rel = path.relative(localPath, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel === "" ? [] : rel.split(path.sep);
  return [arrPath.replace(/[\\/]+$/, ""), ...parts].join(arrPath.includes("\\") && !arrPath.includes("/") ? "\\" : "/");
}

export type ArrTestResult = { ok: boolean; message: string };

const MAX_STATUS_BYTES = 64 * 1024;

/** Parses the status body: JSON with a string `appName` (*arr) or `ProductName` (Jellyfin), or null. */
function parseStatus(text: string, jellyfin: boolean): { appName: string; version: string | null } | null {
  try {
    const body: unknown = JSON.parse(text);
    if (body === null || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    const appName = b[jellyfin ? "ProductName" : "appName"];
    const version = b[jellyfin ? "Version" : "version"];
    return typeof appName === "string" && appName !== "" ? { appName, version: typeof version === "string" ? version : null } : null;
  } catch {
    return null;
  }
}

/** Jellyfin accepts the API key as a MediaBrowser token. */
const jellyfinHeaders = (apiKey: string): Record<string, string> => ({ authorization: `MediaBrowser Token="${apiKey}"` });

/**
 * *arr: GET /api/v3/system/status; Jellyfin: GET /System/Info (needs a valid key, unlike /System/Info/Public). First 64 KB only.
 * Only a JSON answer with an application name counts. Never returns or logs the key.
 */
export async function testArr(cfg: ArrConfig, signal?: AbortSignal): Promise<ArrTestResult> {
  const jellyfin = cfg.kind === "jellyfin";
  try {
    const res = await httpRequest({
      url: joinUrl(cfg.url, jellyfin ? "/System/Info" : "/api/v3/system/status"),
      headers: jellyfin ? jellyfinHeaders(cfg.apiKey) : { "x-api-key": cfg.apiKey },
      maxBytes: MAX_STATUS_BYTES, ...(signal ? { signal } : {}),
    });
    const status = parseStatus(res.text, jellyfin);
    if (!status) return { ok: false, message: `The server answered, but not like ${jellyfin ? "Jellyfin" : "Sonarr or Radarr"} (no application name in the response). Check the URL.` };
    return { ok: true, message: `Connected to ${status.appName}${status.version ? ` ${status.version}` : ""}.` };
  } catch (err) {
    if (err instanceof IntegrationHttpError) return { ok: false, message: err.message === "HTTP 401" ? "HTTP 401: the API key was rejected." : err.message };
    throw err;
  }
}

/** Targeted Jellyfin scan: it refreshes the library folder at each path (204 No Content). */
async function jellyfinUpdated(cfg: ArrConfig, dirs: string[], type: "Created" | "Modified", signal: AbortSignal): Promise<void> {
  await httpRequest({
    url: joinUrl(cfg.url, "/Library/Media/Updated"), method: "POST", headers: jellyfinHeaders(cfg.apiKey),
    json: { Updates: dirs.map((Path) => ({ Path, UpdateType: type })) }, signal,
  });
}

/** Test scan: the same Media/Updated request a run sends, for a folder the user typed. Jellyfin only (an *arr scan would import files). */
export async function testScan(cfg: ArrConfig, dir: string, signal?: AbortSignal): Promise<ArrTestResult> {
  if (cfg.kind !== "jellyfin") return { ok: false, message: "Test scan is only available for Jellyfin targets." };
  try {
    await jellyfinUpdated(cfg, [dir], "Modified", signal ?? AbortSignal.timeout(15_000));
    return { ok: true, message: `Jellyfin accepted the scan request for ${dir}. It only refreshes a folder inside a library: check Dashboard > Logs in a few seconds.` };
  } catch (err) {
    if (err instanceof IntegrationHttpError) return { ok: false, message: err.message === "HTTP 401" ? "HTTP 401: the API key was rejected." : err.message };
    throw err;
  }
}

async function scan(cfg: ArrConfig, dir: string, signal: AbortSignal): Promise<void> {
  if (cfg.kind === "jellyfin") return jellyfinUpdated(cfg, [dir], "Created", signal);
  await httpRequest({
    url: joinUrl(cfg.url, "/api/v3/command"), method: "POST", headers: { "x-api-key": cfg.apiKey },
    json: { name: COMMAND[cfg.kind], path: dir }, signal,
  });
}

const UNREADABLE = "the API key cannot be decrypted (APP_SECRET changed?): save the target again";

function loadTarget(deps: { stores: ArrStores; logger: Logger }, id: number): ArrConfig | string {
  try {
    return deps.stores.arrTargets.getConfig(id);
  } catch (err) {
    return explainError(err, deps.logger, { arrTargetId: id }, UNREADABLE);
  }
}

export function createArrStep(deps: { stores: ArrStores; logger: Logger }): AfterPromoteStep {
  return {
    async run(input: AfterPromoteInput): Promise<PostResult> {
      const link = deps.stores.integrations.get(input.job.id);
      if (link.arrTargetId === null || !link.arrPath) return { warnings: [] };
      const dir = commonDir(input.finalPaths);
      const mapped = dir === null ? null : mapToArrPath(input.job.localPath, link.arrPath, dir);
      if (mapped === null) return { warnings: [`library scan: skipped ${input.unitKey}: its files are not inside the job's local path`] };
      const cfg = loadTarget(deps, link.arrTargetId);
      if (typeof cfg === "string") return { warnings: [`library scan: ${cfg}`] };
      try {
        await scan(cfg, mapped, input.signal);
        return { warnings: [] };
      } catch (err) {
        const why = explainError(err, deps.logger, { target: cfg.name }, UNREADABLE);
        return { warnings: [`library scan ${cfg.name}: scan of ${input.unitKey} failed: ${why}`] };
      }
    },
  };
}

/** The folder to refresh for a removed file: its nearest ancestor that still exists, never above the job's local root. */
export function nearestExistingDir(localPath: string, file: string, exists: (p: string) => boolean = existsSync): string {
  const root = path.resolve(localPath);
  let dir = path.dirname(path.resolve(file));
  while (dir !== root && dir.startsWith(root + path.sep) && !exists(dir)) dir = path.dirname(dir);
  return dir.startsWith(root) ? dir : root;
}

/**
 * After a mirror sweep: tell Jellyfin to refresh the folders whose files left, so it drops them from the library.
 * Sonarr and Radarr are not asked: their scan command imports files and does not notice removals.
 */
export function createArrDeleteStep(deps: { stores: ArrStores; logger: Logger }): AfterDeleteStep {
  return {
    async run(input: AfterDeleteInput): Promise<PostResult> {
      const link = deps.stores.integrations.get(input.job.id);
      if (link.arrTargetId === null || !link.arrPath || input.deletedPaths.length === 0) return { warnings: [] };
      const cfg = loadTarget(deps, link.arrTargetId);
      if (typeof cfg === "string") return { warnings: [`library scan: ${cfg}`] };
      if (cfg.kind !== "jellyfin") return { warnings: [] };
      const dirs = new Set<string>();
      for (const f of input.deletedPaths) {
        const mapped = mapToArrPath(input.job.localPath, link.arrPath, nearestExistingDir(input.job.localPath, f));
        if (mapped !== null) dirs.add(mapped);
      }
      if (dirs.size === 0) return { warnings: [] };
      try {
        await jellyfinUpdated(cfg, [...dirs], "Modified", input.signal);
        return { warnings: [] };
      } catch (err) {
        const why = explainError(err, deps.logger, { target: cfg.name }, UNREADABLE);
        return { warnings: [`library scan ${cfg.name}: refresh after delete failed: ${why}`] };
      }
    },
  };
}
