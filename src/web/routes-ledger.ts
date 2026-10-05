import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { JobConfig } from "../domain.js";
import { unitKeyFor } from "../planner/plan.js";
import type { LedgerRow } from "../store/index.js";
import type { AppDeps } from "./deps.js";
import { formatBytes, formatTime } from "./format.js";
import { redirectTo, render } from "./helpers.js";

const idSchema = z.coerce.number().int().positive();
const Query = z.object({
  q: z.string().trim().max(200).catch(""),
  page: z.coerce.number().int().min(1).catch(1),
  limit: z.coerce.number().int().catch(50).transform((n) => Math.min(200, Math.max(1, n))),
  confirm: z.enum(["file", "unit", "all"]).optional().catch(undefined),
  path: z.string().max(4096).catch(""),
});
type Q = z.infer<typeof Query>;
const PathBody = z.object({ path: z.string().min(1).max(4096), confirmed: z.string().optional() });
const AllBody = z.object({ name: z.string().max(300).catch("") });

const ledgerUrl = (job: JobConfig): string => `/jobs/${job.id}/ledger`;

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  return u.toString() ? `?${u.toString()}` : "";
}

const unitFiles = (paths: Iterable<string>, unit: string): number => [...paths].filter((p) => p === unit || p.startsWith(`${unit}/`)).length;

function rowView(job: JobConfig, q: Q, r: LedgerRow, now: number) {
  const unit = unitKeyFor(r.remotePath, job.unitMode);
  const base = { q: q.q, page: q.page > 1 ? q.page : undefined, path: r.remotePath };
  return {
    path: r.remotePath, size: formatBytes(r.size), syncedHtml: formatTime(r.syncedAt, now), action: r.remoteAction,
    actionAt: r.remoteActionAt === null ? "" : formatTime(r.remoteActionAt, now),
    forgetUrl: `${ledgerUrl(job)}${qs({ ...base, confirm: "file" })}`,
    unit: job.unitMode === "top_dir" && unit !== r.remotePath ? unit : null,
    forgetUnitUrl: `${ledgerUrl(job)}${qs({ ...base, confirm: "unit" })}`,
  };
}

function confirmView(job: JobConfig, deps: AppDeps, q: Q) {
  const active = deps.stores.ledger.active(job.id);
  if (q.confirm === "all") return { kind: "all", target: job.name, path: "", count: active.size };
  if (q.confirm === "file" && active.has(q.path)) return { kind: "file", target: q.path, path: q.path, count: 1 };
  const unit = unitKeyFor(q.path, job.unitMode);
  if (q.confirm === "unit" && unitFiles(active.keys(), unit) > 0) return { kind: "unit", target: unit, path: q.path, count: unitFiles(active.keys(), unit) };
  return null;
}

function pageData(deps: AppDeps, job: JobConfig, q: Q, extra: Record<string, unknown> = {}) {
  const offset = (q.page - 1) * q.limit;
  const { rows, total } = deps.stores.ledger.listActive(job.id, { limit: q.limit, offset, ...(q.q ? { search: q.q } : {}) });
  const all = q.q ? deps.stores.ledger.listActive(job.id, { limit: 1, offset: 0 }).total : total;
  const now = Date.now();
  const nav = (page: number) => `${ledgerUrl(job)}${qs({ q: q.q, page: page > 1 ? page : undefined, limit: q.limit === 50 ? undefined : q.limit })}`;
  return {
    title: `Ledger: ${job.name}`, nav: "jobs", job, rows: rows.map((r) => rowView(job, q, r, now)), total, all, search: q.q,
    page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)), prevUrl: q.page > 1 ? nav(q.page - 1) : null,
    nextUrl: offset + rows.length < total ? nav(q.page + 1) : null, confirm: confirmView(job, deps, q), errors: {}, ...extra,
  };
}

function record(deps: AppDeps, job: JobConfig, scope: string, target: string, count: number): void {
  deps.stores.activity.record({
    category: "ledger.forgot", jobId: job.id, summary: `Forgot ${count} ledger ${count === 1 ? "entry" : "entries"} (${scope}) for ${job.name}`,
    meta: { scope, target, count },
  });
}

type Handler = (job: JobConfig, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => Promise<FastifyReply> | FastifyReply;

function withJob(deps: AppDeps, handler: Handler) {
  return (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const id = idSchema.safeParse(req.params.id);
    const job = id.success ? deps.stores.jobs.get(id.data) : undefined;
    return job ? handler(job, req, reply) : reply.callNotFound();
  };
}

const back = (reply: FastifyReply, job: JobConfig, kind: "ok" | "error", message: string) => redirectTo(reply, ledgerUrl(job), { kind, message });

function forgetOne(deps: AppDeps, scope: "file" | "unit"): Handler {
  return (job, req, reply) => {
    const body = PathBody.safeParse(req.body ?? {});
    if (!body.success) return back(reply, job, "error", "Nothing to forget: no path was given.");
    const { path } = body.data;
    if (body.data.confirmed !== "yes") return redirectTo(reply, `${ledgerUrl(job)}${qs({ confirm: scope, path })}`);
    const active = deps.stores.ledger.active(job.id);
    const target = scope === "file" ? path : unitKeyFor(path, job.unitMode);
    const count = scope === "file" ? Number(active.has(path)) : unitFiles(active.keys(), target);
    if (count === 0) return back(reply, job, "error", "That entry is not in the ledger.");
    if (scope === "file") deps.stores.ledger.forgetFile(job.id, path);
    else deps.stores.ledger.forgetUnit(job.id, target);
    record(deps, job, scope, target, count);
    return back(reply, job, "ok", `Forgot ${count} ${count === 1 ? "file" : "files"}. They will be downloaded again on the next run.`);
  };
}

const forgetAll = (deps: AppDeps): Handler => async (job, req, reply) => {
  const parsed = AllBody.safeParse(req.body ?? {});
  const name = parsed.success ? parsed.data.name : "";
  if (name !== job.name) {
    const data = pageData(deps, job, Query.parse({}), { confirm: { kind: "all", target: job.name, path: "", count: deps.stores.ledger.active(job.id).size }, errors: { name: "The name does not match this job." } });
    return render(reply, deps, "ledger.eta", data, 400);
  }
  const count = deps.stores.ledger.active(job.id).size;
  deps.stores.ledger.forgetAll(job.id);
  record(deps, job, "all", job.name, count);
  return back(reply, job, "ok", `Forgot ${count} files. They will all be downloaded again on the next run.`);
};

export function registerLedgerRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { id: string } }>("/jobs/:id/ledger", withJob(deps, (job, req, reply) =>
    render(reply, deps, "ledger.eta", pageData(deps, job, Query.parse(req.query ?? {})))));
  app.post<{ Params: { id: string } }>("/jobs/:id/ledger/forget", withJob(deps, forgetOne(deps, "file")));
  app.post<{ Params: { id: string } }>("/jobs/:id/ledger/forget-unit", withJob(deps, forgetOne(deps, "unit")));
  app.post<{ Params: { id: string } }>("/jobs/:id/ledger/forget-all", withJob(deps, forgetAll(deps)));
}
