import path from "node:path";
import type { ArrConfig } from "../store/arr-store.js";
import type { Logger } from "../logger.js";
import type { Stores } from "../store/index.js";
import { explainError } from "./explain.js";
import { IntegrationHttpError, httpRequest, joinUrl } from "./http.js";
import type { AfterPromoteInput, AfterPromoteStep, PostResult } from "./types.js";

const COMMAND: Record<ArrConfig["kind"], string> = { sonarr: "DownloadedEpisodesScan", radarr: "DownloadedMoviesScan" };

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

/** Parses the system/status body: JSON with a string `appName` (Sonarr, Radarr, ...) or null. */
function parseStatus(text: string): { appName: string; version: string | null } | null {
  try {
    const body: unknown = JSON.parse(text);
    if (body === null || typeof body !== "object") return null;
    const { appName, version } = body as { appName?: unknown; version?: unknown };
    return typeof appName === "string" && appName !== "" ? { appName, version: typeof version === "string" ? version : null } : null;
  } catch {
    return null;
  }
}

/** GET /api/v3/system/status (first 64 KB). Only a JSON answer with an `appName` counts as an *arr. Never returns or logs the key. */
export async function testArr(cfg: ArrConfig, signal?: AbortSignal): Promise<ArrTestResult> {
  try {
    const res = await httpRequest({ url: joinUrl(cfg.url, "/api/v3/system/status"), headers: { "x-api-key": cfg.apiKey }, maxBytes: MAX_STATUS_BYTES, ...(signal ? { signal } : {}) });
    const status = parseStatus(res.text);
    if (!status) return { ok: false, message: "The server answered, but not like Sonarr or Radarr (no application name in the response). Check the URL." };
    return { ok: true, message: `Connected to ${status.appName}${status.version ? ` ${status.version}` : ""}.` };
  } catch (err) {
    if (err instanceof IntegrationHttpError) return { ok: false, message: err.message === "HTTP 401" ? "HTTP 401: the API key was rejected." : err.message };
    throw err;
  }
}

async function scan(cfg: ArrConfig, dir: string, signal: AbortSignal): Promise<void> {
  await httpRequest({
    url: joinUrl(cfg.url, "/api/v3/command"), method: "POST", headers: { "x-api-key": cfg.apiKey },
    json: { name: COMMAND[cfg.kind], path: dir }, signal,
  });
}

const UNREADABLE = "the *arr API key cannot be decrypted (APP_SECRET changed?): save the target again";

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
      if (mapped === null) return { warnings: [`*arr: skipped ${input.unitKey}: its files are not inside the job's local path`] };
      const cfg = loadTarget(deps, link.arrTargetId);
      if (typeof cfg === "string") return { warnings: [`*arr: ${cfg}`] };
      try {
        await scan(cfg, mapped, input.signal);
        return { warnings: [] };
      } catch (err) {
        const why = explainError(err, deps.logger, { target: cfg.name }, UNREADABLE);
        return { warnings: [`*arr ${cfg.name}: scan of ${input.unitKey} failed: ${why}`] };
      }
    },
  };
}
