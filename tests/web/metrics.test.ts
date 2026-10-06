import { describe, expect, it } from "vitest";
import { formatMetrics } from "../../src/web/metrics.js";
import { makeHarness, req, type Harness } from "./harness.js";

function seedJob(h: Harness, name: string, enabled = true): number {
  const hostId = h.deps.stores.hosts.create({ name: `h-${name}`, protocol: "sftp", host: "example.org", port: 22, username: "u" });
  const id = h.deps.stores.jobs.create({ name, hostId, remotePath: "/r", localPath: `/data/${name.length}-${Math.abs(hostId)}` });
  if (!enabled) h.deps.stores.jobs.update(id, { enabled: false });
  return id;
}

function seedRun(h: Harness, jobId: number, state: string, o: { dry?: boolean; bytes?: number; failed?: number; finishedAt?: number } = {}): void {
  h.deps.db.prepare(
    "INSERT INTO runs (job_id, trigger, state, dry_run, started_at, finished_at, bytes_done, files_failed, created_at) VALUES (?, 'manual', ?, ?, 1, ?, ?, ?, 1)",
  ).run(jobId, state, o.dry ? 1 : 0, o.finishedAt ?? 5_000, o.bytes ?? 0, o.failed ?? 0);
}

function seedLedger(h: Harness, jobId: number, path: string, size: number, forgotten = false): void {
  h.deps.db.prepare("INSERT INTO ledger (job_id, remote_path, size, synced_at, forgotten_at) VALUES (?, ?, ?, 1, ?)").run(jobId, path, size, forgotten ? 2 : null);
}

const get = (h: Harness) => req(h, { method: "GET", url: "/metrics" });

describe("/metrics", () => {
  it("does not exist unless METRICS_ENABLED is set", async () => {
    const h = await makeHarness();
    expect((await get(h)).statusCode).toBe(404);
    const on = await makeHarness({ env: { METRICS_ENABLED: "false" } });
    expect((await get(on)).statusCode).toBe(404);
  });

  it("is served without a login in the Prometheus text format", async () => {
    const h = await makeHarness({ env: { METRICS_ENABLED: "true" } });
    const res = await get(h);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; version=0.0.4");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toContain("# TYPE harvest_jobs gauge");
    expect(res.body).toContain('harvest_jobs{enabled="true"} 0');
    expect(res.body).toContain("harvest_active_runs 0");
    expect(res.body.endsWith("\n")).toBe(true);
  });

  it("reports per-job ledger and last-run values, ignoring dry runs, skipped runs and forgotten files", async () => {
    const h = await makeHarness({ env: { METRICS_ENABLED: "true" } });
    const a = seedJob(h, "movies");
    seedJob(h, "idle", false);
    seedRun(h, a, "failed", { bytes: 10, failed: 2, finishedAt: 1_000_000 });
    seedRun(h, a, "succeeded", { bytes: 500, finishedAt: 2_000_000 });
    seedRun(h, a, "succeeded", { dry: true, bytes: 999, finishedAt: 9_000_000 });
    seedRun(h, a, "skipped_locked", { finishedAt: 9_500_000 });
    seedLedger(h, a, "/r/a", 100);
    seedLedger(h, a, "/r/b", 250);
    seedLedger(h, a, "/r/gone", 7777, true);
    const body = (await get(h)).body;
    expect(body).toContain('harvest_jobs{enabled="true"} 1');
    expect(body).toContain('harvest_jobs{enabled="false"} 1');
    expect(body).toContain('harvest_job_last_run_success{job="movies"} 1');
    expect(body).toContain('harvest_job_last_run_finished_timestamp_seconds{job="movies"} 2000');
    expect(body).toContain('harvest_job_last_run_bytes{job="movies"} 500');
    expect(body).toContain('harvest_job_last_run_failed_files{job="movies"} 0');
    expect(body).toContain('harvest_job_ledger_files{job="movies"} 2');
    expect(body).toContain('harvest_job_ledger_bytes{job="movies"} 350');
    expect(body).toContain('harvest_runs_retained{state="succeeded"} 1');
    expect(body).toContain('harvest_runs_retained{state="failed"} 1');
    expect(body).not.toContain('{job="idle"}');
  });

  it("reports a failed last run as 0 and sums active run speed", async () => {
    const h = await makeHarness({ env: { METRICS_ENABLED: "true" } });
    const a = seedJob(h, "tv");
    seedRun(h, a, "partial", { failed: 3 });
    h.active.push(
      { runId: 1, jobId: a, state: "transferring", trigger: "manual", startedAt: 1, bytesDone: 1, bytesTotal: 2, speedBps: 1500, activeFiles: [] },
      { runId: 2, jobId: a, state: "queued", trigger: "cron", startedAt: null, bytesDone: 0, bytesTotal: 0, speedBps: 500, activeFiles: [] },
    );
    const body = (await get(h)).body;
    expect(body).toContain('harvest_job_last_run_success{job="tv"} 0');
    expect(body).toContain('harvest_job_last_run_failed_files{job="tv"} 3');
    expect(body).toContain("harvest_active_runs 2");
    expect(body).toContain("harvest_active_speed_bytes_per_second 2000");
  });

  it("escapes quotes, backslashes and newlines in job names", async () => {
    const h = await makeHarness({ env: { METRICS_ENABLED: "true" } });
    const a = seedJob(h, 'we"ird\\na\nme');
    seedLedger(h, a, "/r/x", 1);
    expect((await get(h)).body).toContain('harvest_job_ledger_files{job="we\\"ird\\\\na\\nme"} 1');
  });
});

describe("formatMetrics", () => {
  it("omits families without samples and returns empty text for nothing", () => {
    expect(formatMetrics([{ name: "x", help: "h", type: "gauge", samples: [] }])).toBe("");
    expect(formatMetrics([{ name: "x", help: "line\nbreak", type: "gauge", samples: [{ value: 1 }] }])).toBe("# HELP x line\\nbreak\n# TYPE x gauge\nx 1\n");
  });
});
