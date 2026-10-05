import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ActivityRow } from "../store/index.js";
import type { AppDeps } from "./deps.js";
import { formatTime } from "./format.js";
import { render, renderFragment } from "./helpers.js";

const CHUNK = 200;
const MAX_CHUNKS = 50;
const id = z.coerce.number().int().positive();
const blank = (v: unknown): unknown => (v === "" ? undefined : v);

const Query = z.object({
  before: z.preprocess(blank, id.optional().catch(undefined)),
  after: z.preprocess(blank, id.optional().catch(undefined)),
  limit: z.coerce.number().int().catch(50).transform((n) => Math.min(200, Math.max(1, n))),
  job: z.preprocess(blank, id.optional().catch(undefined)),
  severity: z.preprocess(blank, z.enum(["info", "warn", "error"]).optional().catch(undefined)),
  category: z.string().trim().max(80).catch("").transform((s) => s.toLowerCase()),
});
type Q = z.infer<typeof Query>;

/** The store filters by id, job and severity; the category prefix is applied here, scanning newest-first in chunks. */
function collect(deps: AppDeps, q: Q, wanted: number, stop?: (r: ActivityRow) => boolean): ActivityRow[] {
  const out: ActivityRow[] = [];
  let cursor = q.before;
  for (let i = 0; i < MAX_CHUNKS && out.length < wanted; i++) {
    const chunk = deps.stores.activity.list({ ...(cursor !== undefined ? { beforeId: cursor } : {}), limit: CHUNK, ...(q.job !== undefined ? { jobId: q.job } : {}), ...(q.severity ? { severity: q.severity } : {}) });
    for (const r of chunk) {
      if (stop?.(r)) return out;
      if (q.category === "" || r.category.toLowerCase().startsWith(q.category)) out.push(r);
      if (out.length >= wanted) return out;
    }
    if (chunk.length < CHUNK) break;
    cursor = chunk[chunk.length - 1]?.id;
  }
  return out;
}

function metaItems(meta: unknown): { key: string; value: string }[] {
  if (meta === null || meta === undefined) return [];
  const entries: [string, unknown][] = typeof meta === "object" && !Array.isArray(meta) ? Object.entries(meta as Record<string, unknown>) : [["value", meta]];
  return entries.map(([key, v]) => ({ key, value: (typeof v === "string" ? v : JSON.stringify(v) ?? "").slice(0, 500) }));
}

function rowView(r: ActivityRow, names: Map<number, string>, now: number) {
  return {
    id: r.id, whenHtml: formatTime(r.ts, now), category: r.category, severity: r.severity, summary: r.summary,
    jobId: r.jobId, jobName: r.jobId === null ? null : names.get(r.jobId) ?? `Job ${r.jobId}`, runId: r.runId, meta: metaItems(r.meta),
  };
}

const filterQs = (q: Q): URLSearchParams => {
  const u = new URLSearchParams();
  if (q.job !== undefined) u.set("job", String(q.job));
  if (q.severity) u.set("severity", q.severity);
  if (q.category) u.set("category", q.category);
  if (q.limit !== 50) u.set("limit", String(q.limit));
  return u;
};

const withParam = (q: Q, key: string, value: number): string => {
  const u = filterQs(q);
  u.set(key, String(value));
  return `?${u.toString()}`;
};

function rowsData(deps: AppDeps, q: Q, rows: ActivityRow[], hasMore: boolean, live: boolean) {
  const names = new Map(deps.stores.jobs.list().map((j) => [j.id, j.name]));
  const now = Date.now();
  const last = rows[rows.length - 1];
  return {
    rows: rows.map((r) => rowView(r, names, now)),
    olderQuery: hasMore && last ? withParam(q, "before", last.id) : null,
    liveQuery: live ? withParam(q, "after", rows[0]?.id ?? q.after ?? 0) : null,
  };
}

async function page(deps: AppDeps, q: Q, reply: Parameters<typeof render>[0]) {
  const found = collect(deps, q, q.limit + 1);
  const rows = found.slice(0, q.limit);
  const data = rowsData(deps, q, rows, found.length > q.limit, q.before === undefined);
  const jobs = deps.stores.jobs.list().map((j) => ({ id: j.id, name: j.name }));
  return render(reply, deps, "activity.eta", { title: "Activity", nav: "activity", ...data, jobs, filter: { job: q.job ?? "", severity: q.severity ?? "", category: q.category } });
}

async function fragment(deps: AppDeps, q: Q, reply: Parameters<typeof renderFragment>[0]) {
  if (q.after !== undefined) {
    const after = q.after;
    const fresh = collect(deps, { ...q, before: undefined }, 200, (r) => r.id <= after);
    return renderFragment(reply, deps, "partials/activity-rows.eta", rowsData(deps, q, fresh, false, true));
  }
  const found = collect(deps, q, q.limit + 1);
  return renderFragment(reply, deps, "partials/activity-rows.eta", rowsData(deps, q, found.slice(0, q.limit), found.length > q.limit, false));
}

export function registerActivityRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/activity", (req, reply) => page(deps, Query.parse(req.query ?? {}), reply));
  app.get("/activity/rows", (req, reply) => fragment(deps, Query.parse(req.query ?? {}), reply));
}
