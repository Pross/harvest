import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { JobConfig } from "../domain.js";
import { JobBusyError } from "../store/index.js";
import type { TriggerResult } from "../run/manager-types.js";
import { validateSchedule } from "../schedule/schedule-expr.js";
import type { AppDeps } from "./deps.js";
import { formatAbsolute, formatBytes, formatTime } from "./format.js";
import { redirectTo, render, renderFragment, runHook, savedFlash, type FlashKind } from "./helpers.js";
import { bodyStrings, parseId, type FormErrors } from "./host-schemas.js";
import { mirrorAllowInfo } from "./routes-job-mirror.js";
import {
  NEW_JOB_VALUES, crossValidate, hasNoHashes, jobToValues, jobValues, parseJobForm, sizeToInput, type JobFormData,
} from "./job-schemas.js";
import { lastRunByJob } from "./last-runs.js";
import { validateLocalPath } from "./local-browse.js";

const scheduleText = (j: JobConfig): string => {
  if (j.scheduleKind === "manual") return "manual only";
  const s = validateSchedule(j.scheduleKind, j.scheduleExpr);
  return s.ok ? s.human : `${j.scheduleExpr ?? ""} (invalid)`;
};

const afterSyncText = (j: JobConfig): string =>
  j.afterSync === "delete" ? "delete remote files after verified copy"
    : j.afterSync === "delete_after_days" ? `delete remote files ${j.afterDays ?? "?"} days after verified copy`
      : j.afterSync === "move" ? `move remote files to ${j.moveTo ?? "?"} after verified copy` : "keep remote files";

function hostChoices(deps: AppDeps) {
  return deps.stores.hosts.listPublic().map((h) => ({ id: h.id, name: h.name, protocol: h.protocol, noHashes: hasNoHashes(h) }));
}

function listPage(deps: AppDeps) {
  const hosts = new Map(deps.stores.hosts.listPublic().map((h) => [h.id, h.name]));
  const all = deps.stores.jobs.list();
  const last = lastRunByJob(deps, all.map((j) => j.id));
  const jobs = all.map((j) => {
    const run = last.get(j.id);
    return { id: j.id, name: j.name, enabled: j.enabled, host: hosts.get(j.hostId) ?? "?", remotePath: j.remotePath, localPath: j.localPath,
      schedule: scheduleText(j), state: run?.state ?? null, runId: run?.id ?? null, whenHtml: formatTime(run ? run.finishedAt ?? run.startedAt : null) };
  });
  return { title: "Jobs", nav: "jobs", jobs };
}

const MIRROR_SAVED = "Job saved. Mirror mode is not armed yet: run a dry run and review what it would delete. Real runs are refused until then.";

function modeText(j: JobConfig): string {
  if (j.mode !== "mirror") return j.mode;
  return j.mirrorArmedAt === null ? "mirror (not armed: run a dry run before the first real run)" : `mirror (armed ${formatAbsolute(j.mirrorArmedAt)})`;
}

function summaryRows(deps: AppDeps, j: JobConfig): [string, string][] {
  const host = deps.stores.hosts.getPublic(j.hostId);
  return [
    ["Host", host ? `${host.name} (${host.protocol}, ${host.host}:${host.port})` : "missing host"],
    ["Remote path", j.remotePath], ["Local path", j.localPath], ["Schedule", scheduleText(j)],
    ["Mode", `${modeText(j)}, units: ${j.unitMode}, changed files: ${j.changedPolicy}`],
    ["After sync", afterSyncText(j)],
    ["Verify", j.verify], ["Settle / min age", `${j.settleSeconds}s / ${j.minAgeSeconds}s`],
    ["Size filter", `${j.minSize === null ? "none" : sizeToInput(j.minSize)} to ${j.maxSize === null ? "none" : sizeToInput(j.maxSize)}`],
    ["Concurrency", `${j.parallelFiles} files x ${j.rangeStreams} streams, ${j.retries} retries`],
    ["Limits", `bandwidth ${j.bwlimitBps === null ? "unlimited" : `${formatBytes(j.bwlimitBps)}/s`}, min free ${j.minFreeBytes === null ? "none" : formatBytes(j.minFreeBytes)}`],
  ];
}

async function renderJobForm(reply: FastifyReply, deps: AppDeps, job: JobConfig | null, values: Record<string, string>, errors: FormErrors, status = 200) {
  const base = { nav: "jobs", job, values, errors, hosts: hostChoices(deps), action: job ? `/jobs/${job.id}` : "/jobs", mirrorAllow: job ? mirrorAllowInfo(job) : null };
  if (!job) return render(reply, deps, "job-form.eta", { title: "New job", ...base }, status);
  const runs = deps.stores.runs.list(job.id, 10).map((r) => ({
    id: r.id, state: r.state, trigger: r.trigger, whenHtml: formatTime(r.finishedAt ?? r.startedAt),
    result: `${formatBytes(r.bytesDone)}, ${r.filesOk} ok, ${r.filesFailed} failed`,
  }));
  return render(reply, deps, "job-detail.eta", { title: `Job ${job.name}`, ...base, runs, summary: summaryRows(deps, job) }, status);
}

/** Cross-field and filesystem checks; also resolves the local path to its realpath. */
async function checkJob(deps: AppDeps, d: JobFormData, exceptId: number | null): Promise<{ errors: FormErrors; localPath: string }> {
  const taken = deps.stores.jobs.list().some((j) => j.id !== exceptId && j.name.toLowerCase() === d.name.toLowerCase());
  const errors = crossValidate(d, deps.stores.hosts.getPublic(d.hostId), taken, deps.config.TZ);
  const lp = await validateLocalPath(d.localPath, deps.config);
  if (!lp.ok) errors["local_path"] = lp.error;
  return { errors, localPath: lp.ok ? lp.path : d.localPath };
}

function record(d: JobFormData, localPath: string) {
  const { confirmLedgerReset: _confirm, mirrorConfirm: _mirror, ...rest } = d;
  return { ...rest, localPath };
}

/** Turning mirror on (it can delete local files) needs the job's name typed in. */
function mirrorConfirmError(d: JobFormData, was: JobConfig | null): string | null {
  if (d.mode !== "mirror" || was?.mode === "mirror" || d.mirrorConfirm.toLowerCase() === d.name.toLowerCase()) return null;
  return "Mirror mode deletes local files that disappear from the remote. Type the job name here to confirm.";
}

async function createJob(req: FastifyRequest, reply: FastifyReply, deps: AppDeps) {
  const values = jobValues(req.body);
  const parsed = parseJobForm(req.body);
  if (!parsed.ok) return renderJobForm(reply, deps, null, values, parsed.errors, 400);
  const { errors, localPath } = await checkJob(deps, parsed.data, null);
  const confirm = mirrorConfirmError(parsed.data, null);
  if (confirm) errors["mirror_confirm"] = confirm;
  if (Object.keys(errors).length > 0) return renderJobForm(reply, deps, null, values, errors, 400);
  const id = deps.stores.jobs.create(record(parsed.data, localPath));
  const applied = runHook(deps, () => deps.onJobsChanged(), "jobs");
  return redirectTo(reply, `/jobs/${id}`, savedFlash(applied, parsed.data.mode === "mirror" ? MIRROR_SAVED : "Job saved."));
}

async function updateJob(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, deps: AppDeps) {
  const id = parseId(req.params.id);
  const cur = id ? deps.stores.jobs.get(id) : undefined;
  if (!id || !cur) return reply.callNotFound();
  const values = jobValues(req.body);
  const parsed = parseJobForm(req.body);
  if (!parsed.ok) return renderJobForm(reply, deps, cur, values, parsed.errors, 400);
  const d = parsed.data;
  const { errors, localPath } = await checkJob(deps, d, id);
  const resets = cur.hostId !== d.hostId || cur.remotePath !== d.remotePath;
  if (resets && !d.confirmLedgerReset) {
    errors["confirm_ledger_reset"] = "Changing the host or remote path resets this job's ledger (every remote file counts as new again). Tick the box to confirm.";
  }
  const confirm = mirrorConfirmError(d, cur);
  if (confirm) errors["mirror_confirm"] = confirm;
  if (Object.keys(errors).length > 0) return renderJobForm(reply, deps, cur, values, errors, 400);
  const disarm = resets || cur.mode !== d.mode || cur.localPath !== localPath;
  deps.stores.jobs.update(id, { ...record(d, localPath), ...(disarm ? { mirrorArmedAt: null, mirrorAllowLargeAt: null } : {}) });
  if (resets) deps.stores.ledger.forgetAll(id);
  const applied = runHook(deps, () => deps.onJobsChanged(), "jobs");
  const mirrorOff = d.mode === "mirror" && disarm;
  return redirectTo(reply, `/jobs/${id}`, savedFlash(applied, mirrorOff ? MIRROR_SAVED : resets ? "Job saved. The ledger was reset." : "Job saved."));
}

const TRIGGER_MESSAGES: Record<TriggerResult["status"], (r: TriggerResult) => { kind: FlashKind; message: string }> = {
  started: (r) => ({ kind: "ok", message: `Run #${"runId" in r ? r.runId : "?"} started.` }),
  queued: (r) => ({ kind: "ok", message: `Run #${"runId" in r ? r.runId : "?"} queued: it will start when a slot is free.` }),
  skipped_locked: () => ({ kind: "info", message: "This job is already running, so the request was skipped." }),
  rerun_pending: () => ({ kind: "info", message: "This job is already running; it will run again when it finishes." }),
  disabled: () => ({ kind: "error", message: "This job is disabled. Enable it first." }),
};

/** After a list-page action go back to the list; from the detail page stay on it. */
const backTo = (req: FastifyRequest, id: number): string => (bodyStrings(req.body)["next"] === "detail" ? `/jobs/${id}` : "/jobs");

function jobFor(deps: AppDeps, raw: string): JobConfig | undefined {
  const id = parseId(raw);
  return id ? deps.stores.jobs.get(id) : undefined;
}

function deleteJob(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, deps: AppDeps) {
  const job = jobFor(deps, req.params.id);
  if (!job) return reply.callNotFound();
  if (deps.manager.active().some((r) => r.jobId === job.id)) {
    return redirectTo(reply, `/jobs/${job.id}`, { kind: "error", message: "This job is running. Cancel the run before deleting it." });
  }
  let orphans: string[];
  try {
    orphans = deps.stores.jobs.delete(job.id);
  } catch (err) {
    if (!(err instanceof JobBusyError)) throw err;
    return redirectTo(reply, `/jobs/${job.id}`, { kind: "error", message: "This job has a queued or running run. Cancel the run first, then delete the job." });
  }
  const applied = runHook(deps, () => deps.onJobsChanged(), "jobs");
  const left = orphans.length === 0 ? "" : ` ${orphans.length} partial download${orphans.length === 1 ? "" : "s"} remain in the staging folder (${deps.config.tmpDir}) until maintenance removes them.`;
  return redirectTo(reply, "/jobs", savedFlash(applied, `Job "${job.name}" deleted.${left}`));
}

function schedulePreview(deps: AppDeps, query: unknown) {
  const q = bodyStrings(query);
  const kind = q["schedule_kind"] === "cron" || q["schedule_kind"] === "interval" ? q["schedule_kind"] : "manual";
  const r = validateSchedule(kind, (q["schedule_expr"] ?? "").trim() || null, deps.config.TZ);
  return r.ok ? { ok: true, human: r.human, next: r.next.map((d) => formatTime(d.getTime())) } : { ok: false, error: r.error, human: "", next: [] };
}

export function registerJobRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/jobs", async (_req, reply) => render(reply, deps, "jobs.eta", listPage(deps)));
  app.get("/jobs/new", async (_req, reply) => renderJobForm(reply, deps, null, NEW_JOB_VALUES, {}));
  app.get("/jobs/schedule-preview", async (req, reply) => renderFragment(reply, deps, "partials/job-schedule-preview.eta", schedulePreview(deps, req.query)));
  app.post("/jobs", (req, reply) => createJob(req, reply, deps));
  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const job = jobFor(deps, req.params.id);
    return job ? renderJobForm(reply, deps, job, jobToValues(job), {}) : reply.callNotFound();
  });
  app.post<{ Params: { id: string } }>("/jobs/:id", (req, reply) => updateJob(req, reply, deps));
  app.post<{ Params: { id: string } }>("/jobs/:id/delete", async (req, reply) => deleteJob(req, reply, deps));
  app.post<{ Params: { id: string } }>("/jobs/:id/run", async (req, reply) => {
    const job = jobFor(deps, req.params.id);
    if (!job) return reply.callNotFound();
    const result = deps.manager.trigger(job.id, "manual");
    return redirectTo(reply, backTo(req, job.id), TRIGGER_MESSAGES[result.status](result));
  });
  app.post<{ Params: { id: string } }>("/jobs/:id/toggle", async (req, reply) => {
    const job = jobFor(deps, req.params.id);
    if (!job) return reply.callNotFound();
    deps.stores.jobs.update(job.id, { enabled: !job.enabled });
    const applied = runHook(deps, () => deps.onJobsChanged(), "jobs");
    return redirectTo(reply, backTo(req, job.id), savedFlash(applied, `Job "${job.name}" ${job.enabled ? "disabled" : "enabled"}.`));
  });
}
