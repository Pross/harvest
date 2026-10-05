import { Cron } from "croner";
import type { JobConfig } from "../domain.js";
import type { Logger } from "../logger.js";
import type { RunManager } from "../run/manager-types.js";
import type { Stores } from "../store/index.js";
import { parseInterval, validateSchedule } from "./schedule-expr.js";

export type SchedulerDeps = { stores: Stores; manager: RunManager; logger: Logger; tz?: string };
export type Scheduler = {
  start(): void;
  reload(): void;
  stop(): void;
  nextRuns(): { jobId: number; next: Date | null }[];
};

type Entry = { stop(): void; next(): Date | null; sig: string };

export function createScheduler(deps: SchedulerDeps): Scheduler {
  return new SchedulerImpl(deps);
}

class SchedulerImpl implements Scheduler {
  private entries = new Map<number, Entry>();
  /** What was last warned about per job (signature or error), so a warning is recorded once, not on every reload. */
  private warned = new Map<number, string>();
  private running = false;

  constructor(private readonly d: SchedulerDeps) {}

  start(): void {
    this.running = true;
    this.reload();
  }

  stop(): void {
    this.running = false;
    for (const e of this.entries.values()) e.stop();
    this.entries.clear();
    this.warned.clear();
  }

  /** Diffs against the registered entries: only added, removed or changed schedules touch their timers. */
  reload(): void {
    if (!this.running) return;
    const { jobs, bad } = this.d.stores.jobs.scheduledJobsChecked();
    const seen = new Set<number>();
    for (const b of bad) {
      seen.add(b.id);
      this.unregister(b.id);
      this.warnOnce(b.id, `bad:${b.error}`, `Job "${b.name}" could not be read and is not scheduled: ${b.error}`, b.error);
    }
    for (const job of jobs) {
      seen.add(job.id);
      this.sync(job);
    }
    for (const id of [...this.entries.keys(), ...this.warned.keys()]) if (!seen.has(id)) this.drop(id);
  }

  nextRuns(): { jobId: number; next: Date | null }[] {
    return [...this.entries].map(([jobId, e]) => ({ jobId, next: e.next() }));
  }

  private unregister(id: number): void {
    this.entries.get(id)?.stop();
    this.entries.delete(id);
  }

  private drop(id: number): void {
    this.unregister(id);
    this.warned.delete(id);
  }

  private sync(job: JobConfig): void {
    const sig = `${job.scheduleKind}|${job.scheduleExpr}|${this.d.tz ?? ""}`;
    if (this.entries.get(job.id)?.sig === sig) return;
    this.unregister(job.id);
    const check = validateSchedule(job.scheduleKind, job.scheduleExpr, this.d.tz);
    if (!check.ok) return this.reject(job, sig, check.error);
    try {
      const entry = job.scheduleKind === "cron" ? this.cronEntry(job, sig) : this.intervalEntry(job, sig);
      this.entries.set(job.id, entry);
      this.warned.delete(job.id);
    } catch (err) {
      this.reject(job, sig, err instanceof Error ? err.message : String(err));
    }
  }

  private reject(job: JobConfig, sig: string, error: string): void {
    this.warnOnce(job.id, sig, `Schedule for "${job.name}" is invalid and was skipped: ${error}`, error);
  }

  private warnOnce(jobId: number, key: string, summary: string, error: string): void {
    if (this.warned.get(jobId) === key) return;
    this.warned.set(jobId, key);
    this.d.logger.warn({ jobId, error }, "schedule skipped");
    this.guarded(jobId, () => this.d.stores.activity.record({ category: "schedule", severity: "warn", jobId, summary }));
  }

  private cronEntry(job: JobConfig, sig: string): Entry {
    const cron = new Cron(job.scheduleExpr!, { name: `job-${job.id}`, protect: true, unref: true, timezone: this.d.tz }, () => this.fire(job.id, "cron"));
    return { stop: () => cron.stop(), next: () => cron.nextRun(), sig };
  }

  private intervalEntry(job: JobConfig, sig: string): Entry {
    const ms = parseInterval(job.scheduleExpr!);
    let timer: NodeJS.Timeout;
    let nextAt = new Date(Date.now() + ms);
    const arm = (): void => {
      nextAt = new Date(Date.now() + ms);
      timer = setTimeout(() => {
        arm();
        this.fire(job.id, "interval");
      }, ms);
      timer.unref();
    };
    arm();
    return { stop: () => clearTimeout(timer), next: () => nextAt, sig };
  }

  /** The one boundary for scheduled work: log, record activity, keep timers alive. */
  private fire(jobId: number, kind: "cron" | "interval"): void {
    this.guarded(jobId, () => {
      const res = this.d.manager.trigger(jobId, kind);
      this.d.logger.debug({ jobId, kind, status: res.status }, "scheduled trigger");
    });
  }

  private guarded(jobId: number, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.d.logger.error({ err, jobId }, "scheduler task failed");
      try {
        this.d.stores.activity.record({ category: "schedule", severity: "error", jobId, summary: `Scheduled trigger failed: ${String(err)}` });
      } catch (inner) {
        this.d.logger.error({ err: inner }, "could not record activity");
      }
    }
  }
}
