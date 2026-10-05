import type { JobConfig, RunState, RunTrigger } from "../domain.js";
import type { Logger } from "../logger.js";
import type { Stores } from "../store/index.js";
import type { AppEvent, EventBus } from "./events.js";
import type { ActiveRun, RunJob, RunManager, TriggerResult } from "./manager-types.js";

export type RunManagerDeps = {
  runJob: RunJob;
  stores: Stores;
  bus: EventBus;
  logger: Logger;
  maxConcurrentRuns: number;
  now?: () => number;
  /** Random extra delay added to every follow-up timer. Default 0..30000 ms. */
  jitterMs?: () => number;
  /** Ms to wait before the rerun_pending follow-up that starts when a run ends. Default 0 (immediately). */
  followupDelayFor?: (job: JobConfig) => number;
  /** Called (fire and forget, must not throw) when a real run ends without the executor: failed to start, disabled, or skipped_locked. */
  notifyEnd?: (job: JobConfig, runId: number, state: RunState, error: string) => void;
};

export type ManagedRunManager = RunManager & {
  scheduleFollowup(jobId: number, atMs: number): void;
  recoverOnBoot(): number;
  /** Jobs that currently have a queued or running run in this process. */
  busyJobIds(): Set<number>;
};

import { defaultJitter, errMsg, isTerminal, SKIP_COALESCE_MS, type Entry, type Followup } from "./manager-support.js";

export function createRunManager(deps: RunManagerDeps): ManagedRunManager {
  return new Manager(deps);
}

class Manager implements ManagedRunManager {
  private readonly queue: Entry[] = [];
  private readonly running = new Map<number, { entry: Entry; done: Promise<void> }>();
  private readonly busy = new Map<number, number>();
  private readonly activeRuns = new Map<number, ActiveRun>();
  private readonly followups = new Map<number, Followup>();
  private readonly skipped = new Map<number, { runId: number; at: number }>();
  private readonly afterQueue: Entry[] = [];
  private inAfter = false;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly d: RunManagerDeps) {
    this.now = d.now ?? Date.now;
    this.unsubscribe = d.bus.subscribe((e) => this.onEvent(e));
  }

  /** After runs.create + busy.set nothing here may throw: bookkeeping is complete before any event goes out. */
  trigger(jobId: number, trigger: RunTrigger, opts?: { dryRun?: boolean }): TriggerResult {
    if (this.stopped) throw new Error("run manager is stopped");
    const job = this.d.stores.jobs.get(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    if (!job.enabled) return { status: "disabled" };
    const dryRun = opts?.dryRun ?? false;
    if (this.busy.has(jobId)) return this.locked(jobId, trigger, dryRun);
    const runId = this.d.stores.runs.create(jobId, trigger, dryRun);
    const entry: Entry = { runId, jobId, trigger, dryRun, ac: new AbortController(), userCancelled: false };
    this.busy.set(jobId, runId);
    this.track(entry);
    const status = this.running.size < this.d.maxConcurrentRuns ? "started" : "queued";
    if (status === "started") this.start(entry);
    else this.queue.push(entry);
    this.emit({ type: "run.state", runId, jobId, state: "queued" });
    return { status, runId };
  }

  cancel(runId: number): boolean {
    const at = this.queue.findIndex((e) => e.runId === runId);
    if (at >= 0) {
      const [entry] = this.queue.splice(at, 1);
      this.d.stores.jobs.setRerunPending(entry!.jobId, false);
      this.finishQueued(entry!, "cancelled by user");
      return true;
    }
    const r = this.running.get(runId);
    if (!r) return false;
    r.entry.userCancelled = true;
    r.entry.ac.abort();
    return true;
  }

  active(): ActiveRun[] {
    return [...this.activeRuns.values()].map((a) => ({ ...a, activeFiles: [...a.activeFiles] }));
  }

  busyJobIds(): Set<number> {
    return new Set(this.busy.keys());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const f of this.followups.values()) clearTimeout(f.timer);
    this.followups.clear();
    for (const e of this.queue.splice(0)) this.guarded("stop", e.jobId, () => this.finishQueued(e, "cancelled by shutdown"));
    for (const r of this.running.values()) r.entry.ac.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
    this.unsubscribe();
  }

  scheduleFollowup(jobId: number, atMs: number): void {
    if (this.stopped) return;
    const cur = this.followups.get(jobId);
    if (cur && cur.atMs <= atMs) return;
    if (cur) clearTimeout(cur.timer);
    const delay = Math.max(0, atMs - this.now()) + (this.d.jitterMs ?? defaultJitter)();
    const timer = setTimeout(() => this.fireFollowup(jobId), delay);
    timer.unref();
    this.followups.set(jobId, { atMs, timer });
  }

  /** Fails runs the last process left behind and re-arms a follow-up for every job that still has rerun_pending set. */
  recoverOnBoot(): number {
    const { runs, jobs } = this.d.stores;
    const n = runs.failNonTerminal("interrupted by restart");
    if (n > 0) this.d.logger.warn({ count: n }, "marked interrupted runs as failed");
    for (const id of jobs.rerunPendingIds()) this.guarded("recover-rerun", id, () => this.restoreRerun(id));
    return n;
  }

  private restoreRerun(jobId: number): void {
    const job = this.d.stores.jobs.get(jobId);
    if (!job || !job.enabled) this.d.stores.jobs.setRerunPending(jobId, false);
    else this.scheduleFollowup(jobId, this.now());
  }

  private fireFollowup(jobId: number): void {
    this.followups.delete(jobId);
    this.guarded("followup", jobId, () => {
      if (!this.busy.has(jobId)) this.d.stores.jobs.setRerunPending(jobId, false);
      this.trigger(jobId, "followup");
    });
  }

  /** Webhooks and follow-ups on a busy job coalesce into rerun_pending; other triggers leave (at most one per window) skipped_locked row. */
  private locked(jobId: number, trigger: RunTrigger, dryRun: boolean): TriggerResult {
    const { runs, jobs } = this.d.stores;
    if (trigger === "webhook" || trigger === "followup") {
      jobs.setRerunPending(jobId, true);
      return { status: "rerun_pending" };
    }
    const last = this.skipped.get(jobId);
    if (last && this.now() - last.at < SKIP_COALESCE_MS) return { status: "skipped_locked", runId: last.runId };
    const runId = runs.create(jobId, trigger, dryRun);
    runs.setState(runId, "skipped_locked", "job already has a queued or running run");
    if (!dryRun) this.notifyEnd(jobId, runId, "skipped_locked", "job already has a queued or running run");
    this.skipped.set(jobId, { runId, at: this.now() });
    this.emit({ type: "run.state", runId, jobId, state: "skipped_locked" });
    return { status: "skipped_locked", runId };
  }

  private track(e: Entry): void {
    this.activeRuns.set(e.runId, {
      runId: e.runId, jobId: e.jobId, state: "queued", trigger: e.trigger, startedAt: null,
      bytesDone: 0, bytesTotal: 0, speedBps: 0, activeFiles: [],
    });
  }

  private release(e: Entry): void {
    if (this.busy.get(e.jobId) === e.runId) this.busy.delete(e.jobId);
    this.activeRuns.delete(e.runId);
  }

  private finishQueued(e: Entry, note: string): void {
    try {
      this.d.stores.runs.setState(e.runId, "cancelled", note);
    } finally {
      this.release(e);
    }
    this.emit({ type: "run.state", runId: e.runId, jobId: e.jobId, state: "cancelled" });
  }

  /** Registers the run before any code that can throw, so the entry can never be orphaned in `running`. */
  private start(e: Entry): void {
    const slot = { entry: e, done: Promise.resolve() };
    this.running.set(e.runId, slot);
    slot.done = this.execute(e);
  }

  private async execute(e: Entry): Promise<void> {
    try {
      await Promise.resolve();
      await this.runEntry(e);
    } catch (err) {
      this.failRun(e, err);
    } finally {
      this.running.delete(e.runId);
      this.release(e);
      this.afterRun(e);
    }
  }

  private async runEntry(e: Entry): Promise<void> {
    if (e.ac.signal.aborted) return this.endUnstarted(e, e.userCancelled ? "cancelled by user" : "cancelled by shutdown");
    const job = this.d.stores.jobs.get(e.jobId);
    if (!job) throw new Error(`job ${e.jobId} was deleted before its run started`);
    if (!job.enabled) return this.endUnstarted(e, "job was disabled before its run started");
    await this.d.runJob(job, e.runId, e.ac.signal);
    this.ensureTerminal(e);
  }

  private endUnstarted(e: Entry, note: string): void {
    this.d.stores.runs.setState(e.runId, "cancelled", note);
    if (!e.dryRun) this.notifyEnd(e.jobId, e.runId, "cancelled", note);
    this.emit({ type: "run.state", runId: e.runId, jobId: e.jobId, state: "cancelled" });
  }

  /** A runJob that returns without leaving a terminal state would leave the run non-terminal forever. */
  private ensureTerminal(e: Entry): void {
    const row = this.d.stores.runs.get(e.runId);
    if (!row || isTerminal(row.state)) return;
    const state: RunState = e.ac.signal.aborted ? "cancelled" : "failed";
    this.d.stores.runs.setState(e.runId, state, "run ended without a terminal state");
    this.d.logger.error({ runId: e.runId, jobId: e.jobId, was: row.state }, "run ended without a terminal state");
    this.emit({ type: "run.state", runId: e.runId, jobId: e.jobId, state });
  }

  private failRun(e: Entry, err: unknown): void {
    this.guarded("run", e.jobId, () => {
      const wanted: RunState = e.ac.signal.aborted ? "cancelled" : "failed";
      this.d.logger.error({ err, runId: e.runId, jobId: e.jobId }, "run ended with an exception");
      this.d.stores.runs.setState(e.runId, wanted, errMsg(err));
      const state = this.d.stores.runs.get(e.runId)?.state ?? wanted;
      this.d.stores.activity.record({ category: "run", severity: "error", jobId: e.jobId, runId: e.runId, summary: `Run ${e.runId} ${state}: ${errMsg(err)}` });
      this.emit({ type: "run.state", runId: e.runId, jobId: e.jobId, state });
      if (!e.dryRun && state === wanted) this.notifyEnd(e.jobId, e.runId, state, errMsg(err));
    });
  }

  private notifyEnd(jobId: number, runId: number, state: RunState, error: string): void {
    const job = this.d.stores.jobs.get(jobId);
    if (job) this.d.notifyEnd?.(job, runId, state, error);
  }

  /** Non-reentrant: a nested call only queues its entry for the outer loop. */
  private afterRun(e: Entry): void {
    this.afterQueue.push(e);
    if (this.inAfter) return;
    this.inAfter = true;
    try {
      for (let next = this.afterQueue.shift(); next; next = this.afterQueue.shift()) this.afterEach(next);
    } finally {
      this.inAfter = false;
    }
  }

  private afterEach(e: Entry): void { this.guarded("after-run", e.jobId, () => this.afterOne(e)); }

  private afterOne(e: Entry): void {
    if (this.stopped) return;
    while (this.running.size < this.d.maxConcurrentRuns && this.queue.length > 0) this.start(this.queue.shift()!);
    const job = this.d.stores.jobs.get(e.jobId);
    if (!job?.rerunPending) return;
    this.d.stores.jobs.setRerunPending(e.jobId, false);
    if (e.userCancelled) return;
    const delay = this.d.followupDelayFor?.(job) ?? 0;
    if (delay > 0) this.scheduleFollowup(e.jobId, this.now() + delay);
    else this.trigger(e.jobId, "followup");
  }

  private emit(ev: AppEvent): void {
    try {
      this.d.bus.emit(ev);
    } catch (err) {
      this.d.logger.error({ err, type: ev.type }, "event bus emit failed");
    }
  }

  /** The single boundary for background work: log, record activity, never rethrow. */
  private guarded(what: string, jobId: number, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.d.logger.error({ err, jobId, what }, "run manager background task failed");
      try {
        this.d.stores.activity.record({ category: "run", severity: "error", jobId, summary: `Run manager ${what} failed: ${errMsg(err)}` });
      } catch (inner) {
        this.d.logger.error({ err: inner }, "could not record activity");
      }
    }
  }

  private onEvent(ev: AppEvent): void {
    if (ev.type !== "run.state" && ev.type !== "run.progress") return;
    const a = this.activeRuns.get(ev.runId);
    if (!a) return;
    if (ev.type === "run.state") {
      a.state = ev.state;
      if (ev.state !== "queued" && a.startedAt === null) a.startedAt = this.now();
      if (isTerminal(ev.state) && !this.running.has(ev.runId)) this.activeRuns.delete(ev.runId);
      return;
    }
    Object.assign(a, { bytesDone: ev.bytesDone, bytesTotal: ev.bytesTotal, speedBps: ev.speedBps, activeFiles: ev.activeFiles });
  }
}
