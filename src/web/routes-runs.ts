import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TERMINAL_RUN_STATES, type RunState } from "../domain.js";
import type { ActivityRow, RunFileRow, RunRow } from "../store/index.js";
import type { AppDeps } from "./deps.js";
import { DRY_SUMMARY_CATEGORY, type DrySummary } from "../run/dry-run.js";
import { DRY_MIRROR_CATEGORY, type DryMirrorSummary } from "../run/mirror-sweep.js";
import { dryRunView } from "./dryrun-view.js";
import { formatBytes, formatDuration, formatSpeed, formatTime } from "./format.js";
import { redirectTo, render, renderFragment } from "./helpers.js";

const RUN_STATES = [
  "queued", "connecting", "listing", "planning", "awaiting_space", "transferring", "verifying", "finalizing",
  "post_actions", "succeeded", "partial", "failed", "cancelled", "skipped_locked", "skipped_space",
] as const satisfies readonly RunState[];
/** The run store has no keyset/filter query yet, so lists are filtered in memory over this many newest rows. */
const SCAN_CAP = 5000;
const FILE_CAP = 500;
const BADGED = new Set<string>(["succeeded", "partial", "failed", "cancelled", "skipped_locked", "skipped_space", "awaiting_space"]);

const id = z.coerce.number().int().positive();
const ListQuery = z.object({
  before: id.optional().catch(undefined),
  limit: z.coerce.number().int().catch(50).transform((n) => Math.min(200, Math.max(1, n))),
  job: id.optional().catch(undefined),
  state: z.enum(RUN_STATES).optional().catch(undefined),
});
const DetailQuery = z.object({ state: z.string().max(40).optional().catch(undefined) });

const isTerminal = (s: RunState): boolean => TERMINAL_RUN_STATES.includes(s);
const badgeClass = (s: string): string => `st-${BADGED.has(s) ? s : "active"}`;

function runView(r: RunRow, names: Map<number, string>, now: number) {
  const end = r.finishedAt ?? now;
  const seconds = r.startedAt === null ? null : Math.max(0, (end - r.startedAt) / 1000);
  const speed = seconds && seconds > 0 && r.bytesDone > 0 ? r.bytesDone / seconds : null;
  return {
    id: r.id, jobId: r.jobId, jobName: names.get(r.jobId) ?? `Job ${r.jobId}`, state: r.state, badge: badgeClass(r.state),
    trigger: r.trigger, dryRun: r.dryRun, whenHtml: formatTime(r.startedAt, now), duration: formatDuration(seconds),
    bytes: formatBytes(r.bytesDone), total: formatBytes(r.bytesTotal), speed: formatSpeed(speed),
    files: `${r.filesOk}/${r.filesPlanned}`, failed: r.filesFailed, skipped: r.filesSkipped, error: r.error, terminal: isTerminal(r.state),
  };
}

const jobNames = (deps: AppDeps): Map<number, string> => new Map(deps.stores.jobs.list().map((j) => [j.id, j.name]));
const nowOf = (): number => Date.now();

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

function listData(deps: AppDeps, q: z.infer<typeof ListQuery>) {
  const all = q.job !== undefined ? deps.stores.runs.list(q.job, SCAN_CAP) : deps.stores.runs.listRecent(SCAN_CAP);
  const matching = all.filter((r) => (q.before === undefined || r.id < q.before) && (q.state === undefined || r.state === q.state));
  const page = matching.slice(0, q.limit);
  const last = page[page.length - 1];
  const names = jobNames(deps);
  const now = nowOf();
  return {
    title: "Runs", nav: "runs", runs: page.map((r) => runView(r, names, now)), states: RUN_STATES,
    jobs: [...names].map(([jobId, name]) => ({ id: jobId, name })), filter: { job: q.job ?? "", state: q.state ?? "" },
    olderUrl: matching.length > q.limit && last ? `/runs${qs({ before: last.id, job: q.job, state: q.state, limit: q.limit === 50 ? undefined : q.limit })}` : null,
  };
}

function timeline(deps: AppDeps, run: RunRow) {
  const rows: ActivityRow[] = deps.stores.activity.list({ jobId: run.jobId, limit: 500 }).filter((a) => a.runId === run.id);
  return rows.reverse().map((a) => ({ whenHtml: formatTime(a.ts, nowOf()), category: a.category, severity: a.severity, summary: a.summary }));
}

function fileView(f: RunFileRow) {
  return {
    path: f.remotePath, state: f.state, badge: f.state === "failed" ? "st-failed" : f.state === "done" ? "st-succeeded" : f.state === "skipped" ? "st-skipped_locked" : "st-active",
    bytes: formatBytes(f.bytes), size: formatBytes(f.size), attempts: f.attempts, error: f.error,
  };
}

function drySummary(deps: AppDeps, run: RunRow): DrySummary | undefined {
  const row = deps.stores.activity.list({ runId: run.id, category: DRY_SUMMARY_CATEGORY, limit: 1 })[0];
  return row ? (row.meta as DrySummary) : undefined;
}

function dryMirror(deps: AppDeps, run: RunRow): DryMirrorSummary | undefined {
  const row = deps.stores.activity.list({ runId: run.id, category: DRY_MIRROR_CATEGORY, limit: 1 })[0];
  return row ? (row.meta as DryMirrorSummary) : undefined;
}

function detailData(deps: AppDeps, run: RunRow, stateFilter: string | undefined) {
  const files = deps.stores.runs.filesForRun(run.id);
  const shown = files.filter((f) => stateFilter === undefined || stateFilter === "" || f.state === stateFilter);
  return {
    run: runView(run, jobNames(deps), nowOf()), dryRun: run.dryRun ? dryRunView(files, deps.stores.jobs.get(run.jobId), drySummary(deps, run), dryMirror(deps, run)) : null, timeline: timeline(deps, run),
    files: shown.slice(0, FILE_CAP).map(fileView), hiddenFiles: Math.max(0, shown.length - FILE_CAP),
    fileStates: [...new Set(files.map((f) => f.state))].sort(), fileFilter: stateFilter ?? "", totalFiles: files.length,
  };
}

type IdReq = FastifyRequest<{ Params: { id: string } }>;

const findRun = (deps: AppDeps, req: IdReq): RunRow | undefined => {
  const runId = id.safeParse(req.params.id);
  return runId.success ? deps.stores.runs.get(runId.data) : undefined;
};

function cancelRun(deps: AppDeps, run: RunRow, reply: FastifyReply) {
  const back = `/runs/${run.id}`;
  if (isTerminal(run.state)) return redirectTo(reply, back, { kind: "error", message: `Run ${run.id} already finished (${run.state}).` });
  const ok = deps.manager.cancel(run.id);
  return redirectTo(reply, back, ok ? { kind: "ok", message: "Cancel requested." } : { kind: "info", message: "That run is no longer active." });
}

export function registerRunsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/runs", async (req, reply) => render(reply, deps, "runs.eta", listData(deps, ListQuery.parse(req.query ?? {}))));
  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const run = findRun(deps, req);
    if (!run) return reply.callNotFound();
    const data = detailData(deps, run, DetailQuery.parse(req.query ?? {}).state);
    return render(reply, deps, "run-detail.eta", { title: `Run ${run.id}`, nav: "runs", ...data });
  });
  app.get<{ Params: { id: string } }>("/runs/:id/live", async (req, reply) => {
    const run = findRun(deps, req);
    if (!run) return reply.callNotFound();
    return renderFragment(reply, deps, "partials/run-live.eta", detailData(deps, run, DetailQuery.parse(req.query ?? {}).state));
  });
  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (req, reply) => {
    const run = findRun(deps, req);
    return run ? cancelRun(deps, run, reply) : reply.callNotFound();
  });
}
