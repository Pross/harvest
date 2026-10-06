import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./deps.js";

type Sample = { labels?: Record<string, string>; value: number };
type Family = { name: string; help: string; type: "gauge" | "counter"; samples: Sample[] };

const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labelText = (labels: Record<string, string> | undefined): string => {
  const parts = Object.entries(labels ?? {}).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
};

/** Prometheus text exposition format 0.0.4. A family with no samples is omitted rather than emitted empty. */
export function formatMetrics(families: Family[]): string {
  const out: string[] = [];
  for (const f of families) {
    if (f.samples.length === 0) continue;
    out.push(`# HELP ${f.name} ${f.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`, `# TYPE ${f.name} ${f.type}`);
    for (const s of f.samples) out.push(`${f.name}${labelText(s.labels)} ${s.value}`);
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

type LedgerAgg = { job_id: number; files: number; bytes: number };
type LastRun = { job_id: number; state: string; finished_at: number; bytes_done: number; files_failed: number };
type StateCount = { state: string; n: number };

const gauge = (name: string, help: string, samples: Sample[]): Family => ({ name, help, type: "gauge", samples });

function runFamilies(deps: AppDeps): Family[] {
  const active = deps.manager.active();
  const states = deps.db.prepare("SELECT state, COUNT(*) AS n FROM runs WHERE dry_run = 0 GROUP BY state ORDER BY state").all() as StateCount[];
  return [
    gauge("harvest_active_runs", "Runs currently queued or executing.", [{ value: active.length }]),
    gauge("harvest_active_speed_bytes_per_second", "Combined transfer speed of active runs.", [{ value: active.reduce((n, r) => n + r.speedBps, 0) }]),
    gauge("harvest_runs_retained", "Non-dry runs still in the database by state. Old runs are purged, so this is not a lifetime counter.",
      states.map((s) => ({ labels: { state: s.state }, value: s.n }))),
    gauge("harvest_process_start_time_seconds", "Unix time this Harvest process started.", [{ value: Math.floor(Date.now() / 1000 - process.uptime()) }]),
  ];
}

function jobFamilies(deps: AppDeps): Family[] {
  const jobs = deps.stores.jobs.list();
  const name = new Map(jobs.map((j) => [j.id, j.name]));
  const ledger = deps.db.prepare(
    "SELECT job_id, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM ledger WHERE forgotten_at IS NULL GROUP BY job_id",
  ).all() as LedgerAgg[];
  const last = deps.db.prepare(
    `SELECT job_id, state, finished_at, bytes_done, files_failed FROM runs
     WHERE id IN (SELECT MAX(id) FROM runs WHERE dry_run = 0 AND state IN ('succeeded','partial','failed') GROUP BY job_id)`,
  ).all() as LastRun[];
  const perJob = <T extends { job_id: number }>(rows: T[], value: (r: T) => number): Sample[] =>
    rows.filter((r) => name.has(r.job_id)).map((r) => ({ labels: { job: name.get(r.job_id)! }, value: value(r) }));
  return [
    gauge("harvest_jobs", "Configured jobs by enabled state.", [
      { labels: { enabled: "true" }, value: jobs.filter((j) => j.enabled).length },
      { labels: { enabled: "false" }, value: jobs.filter((j) => !j.enabled).length },
    ]),
    gauge("harvest_job_last_run_success", "1 if the job's last finished run succeeded, 0 for partial or failed.", perJob(last, (r) => (r.state === "succeeded" ? 1 : 0))),
    gauge("harvest_job_last_run_finished_timestamp_seconds", "Unix time the job's last finished run ended.", perJob(last, (r) => Math.floor(r.finished_at / 1000))),
    gauge("harvest_job_last_run_bytes", "Bytes transferred by the job's last finished run.", perJob(last, (r) => r.bytes_done)),
    gauge("harvest_job_last_run_failed_files", "Files that failed in the job's last finished run.", perJob(last, (r) => r.files_failed)),
    gauge("harvest_job_ledger_files", "Files recorded in the job's ledger (not forgotten).", perJob(ledger, (r) => r.files)),
    gauge("harvest_job_ledger_bytes", "Total size of files recorded in the job's ledger.", perJob(ledger, (r) => r.bytes)),
  ];
}

/**
 * Everything is read from SQLite at scrape time, so values survive restarts and nothing needs instrumenting in the run path.
 * Dry runs are excluded throughout: they have no side effects and would make a job look healthier than it is.
 */
export function collectMetrics(deps: AppDeps): Family[] {
  return [...jobFamilies(deps), ...runFamilies(deps)];
}

/** Unauthenticated by design (METRICS_ENABLED is off by default): anyone who can reach the port can read job names and stats. */
export function registerMetrics(app: FastifyInstance, deps: AppDeps): void {
  app.get("/metrics", async (_req, reply) => {
    try {
      return reply.type("text/plain; version=0.0.4; charset=utf-8").header("cache-control", "no-store").send(formatMetrics(collectMetrics(deps)));
    } catch (err) {
      deps.logger.error({ err }, "Metrics collection failed");
      return reply.code(500).type("text/plain").send("metrics unavailable\n");
    }
  });
}
