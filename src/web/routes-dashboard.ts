import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import cronstrue from "cronstrue";
import type { JobConfig } from "../domain.js";
import type { RunRow } from "../store/index.js";
import type { AppDeps } from "./deps.js";
import { formatBytes, formatEta, formatSpeed, formatTime, sparklineSvg } from "./format.js";
import { render, renderFragment } from "./helpers.js";
import { lastRunByJob } from "./last-runs.js";

const jobNames = (deps: AppDeps): Map<number, string> => new Map(deps.stores.jobs.list().map((j) => [j.id, j.name]));
const pct = (done: number, total: number): number => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);

/** Active transfers panel data (also rendered into SSE `run-progress` frames). */
export function activeTransfersData(deps: AppDeps) {
  const names = jobNames(deps);
  const runs = deps.manager.active().map((r) => ({
    runId: r.runId, jobName: names.get(r.jobId) ?? `Job ${r.jobId}`, state: r.state,
    pct: pct(r.bytesDone, r.bytesTotal), done: formatBytes(r.bytesDone), total: formatBytes(r.bytesTotal),
    speed: formatSpeed(r.speedBps), eta: formatEta(r.bytesDone, r.bytesTotal, r.speedBps),
    files: r.activeFiles.slice(0, 5).map((f) => ({ path: f.path, pct: pct(f.bytes, f.total), done: formatBytes(f.bytes), total: formatBytes(f.total) })),
    moreFiles: Math.max(0, r.activeFiles.length - 5),
  }));
  return { runs };
}

function humanSchedule(job: JobConfig | undefined): string {
  if (!job || job.scheduleKind === "manual" || !job.scheduleExpr) return "";
  if (job.scheduleKind === "interval") return `every ${job.scheduleExpr}`;
  try {
    return cronstrue.toString(job.scheduleExpr);
  } catch {
    return job.scheduleExpr;
  }
}

export function nextRunsData(deps: AppDeps) {
  const jobs = new Map(deps.stores.jobs.list().map((j) => [j.id, j]));
  const next = deps.scheduler.nextRuns()
    .flatMap((n) => (n.next && jobs.has(n.jobId) ? [{ job: jobs.get(n.jobId), when: n.next.getTime() }] : []))
    .sort((a, b) => a.when - b.when)
    .map((n) => ({ jobId: n.job?.id ?? 0, name: n.job?.name ?? "", human: humanSchedule(n.job), whenHtml: formatTime(n.when) }));
  return { next };
}

export function lastRunsData(deps: AppDeps) {
  const jobs = deps.stores.jobs.list();
  const last = lastRunByJob(deps, jobs.map((j) => j.id));
  const lastRuns = jobs.map((job) => {
    const run: RunRow | undefined = last.get(job.id);
    return {
      jobId: job.id, name: job.name, enabled: job.enabled, runId: run?.id ?? null, state: run?.state ?? null,
      whenHtml: formatTime(run ? run.finishedAt ?? run.startedAt : null),
      summary: run ? `${formatBytes(run.bytesDone)}, ${run.filesOk} ok, ${run.filesFailed} failed` : "",
    };
  });
  return { lastRuns };
}

const dayKey = (d: Date): string => d.toLocaleDateString("en-CA");

/** Bytes transferred per local day for the last 7 days (oldest first), from runs.bytes_done. */
export function volumeData(deps: AppDeps, now = new Date()) {
  const days: { key: string; label: string; bytes: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push({ key: dayKey(d), label: d.toLocaleDateString("en-US", { weekday: "short" }), bytes: 0 });
  }
  for (const r of deps.stores.runs.listRecent(1000)) {
    const ts = r.finishedAt ?? r.startedAt;
    const day = ts === null ? undefined : days.find((x) => x.key === dayKey(new Date(ts)));
    if (day) day.bytes += r.bytesDone;
  }
  const total = days.reduce((s, d) => s + d.bytes, 0);
  return { volume: { svg: sparklineSvg(days.map((d) => d.bytes)), total: formatBytes(total), days: days.map((d) => ({ label: d.label, size: formatBytes(d.bytes) })) } };
}

const STATFS_TIMEOUT_MS = 2000;
const STATFS_TTL_MS = 10_000;
type Disk = { path: string; ok: boolean; free: string; total: string; usedPct: number };
const diskCache = new Map<string, { at: number; disk: Disk }>();

async function statDisk(p: string): Promise<Disk> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("statfs timed out")), STATFS_TIMEOUT_MS); });
  try {
    const s = await Promise.race([fs.statfs(p), timeout]);
    return { path: p, ok: true, free: formatBytes(s.bavail * s.bsize), total: formatBytes(s.blocks * s.bsize), usedPct: pct((s.blocks - s.bavail), s.blocks) };
  } catch {
    return { path: p, ok: false, free: "unavailable", total: "", usedPct: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Cached for 10 s so a hung network mount cannot stall every dashboard load; each stat gives up after 2 s. */
async function cachedDisk(p: string): Promise<Disk> {
  const hit = diskCache.get(p);
  if (hit && Date.now() - hit.at < STATFS_TTL_MS) return hit.disk;
  const disk = await statDisk(p);
  diskCache.set(p, { at: Date.now(), disk });
  return disk;
}

/** Free space per distinct local target; errors and timeouts become `ok: false` ("unavailable"), never thrown. */
export async function diskData(deps: AppDeps) {
  const paths = [...new Set(deps.stores.jobs.list().map((j) => j.localPath))];
  return { disks: await Promise.all(paths.map(cachedDisk)) };
}

const PANELS: Record<string, (deps: AppDeps) => Record<string, unknown>> = {
  "active-transfers": (d) => activeTransfersData(d),
  "next-runs": (d) => nextRunsData(d),
  "last-runs": (d) => lastRunsData(d),
};

/** Dashboard page plus htmx fragments (`/fragments/:panel`) used for SSE-triggered refreshes. */
export function registerDashboardRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/", async (_req, reply) => {
    const data = {
      title: "Dashboard", nav: "dashboard", ...activeTransfersData(deps), ...nextRunsData(deps),
      ...lastRunsData(deps), ...volumeData(deps), ...(await diskData(deps)),
    };
    return render(reply, deps, "dashboard.eta", data);
  });
  app.get<{ Params: { panel: string } }>("/fragments/:panel", async (req, reply) => {
    const build = Object.hasOwn(PANELS, req.params.panel) ? PANELS[req.params.panel] : undefined;
    if (!build) return reply.callNotFound();
    return renderFragment(reply, deps, `partials/${req.params.panel}.eta`, build(deps));
  });
}
