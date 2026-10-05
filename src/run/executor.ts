import type { HostConfig, JobConfig, RunState } from "../domain.js";
import { HostKeyChanged } from "../errors.js";
import type { EngineSession, RemoteEntry, TransferEngine } from "../engine/types.js";
import type { Logger } from "../logger.js";
import type { PostPipeline } from "../post/types.js";
import { planRun } from "../planner/plan.js";
import type { Plan, PlannedUnit } from "../planner/types.js";
import type { Stores } from "../store/index.js";
import type { Slots } from "./connection-slots.js";
import { recordDryRun } from "./dry-run.js";
import type { EventBus } from "./events.js";
import type { RunJob } from "./manager-types.js";
import { ensureStaging, type SameDevice } from "./paths.js";
import type { DownloadFileRequest } from "./range-downloader.js";
import { fitToSpace, unitFits, type SpaceReservations, type Statfs, defaultStatfs } from "./space.js";
import { abortError } from "./throttle.js";
import { isFatal, processUnit, Tracker, type RunCtx, type Severity } from "./transfer-unit.js";
import type { Throttle } from "./types.js";

export type ExecutorDeps = {
  engine: TransferEngine;
  stores: Stores;
  bus: EventBus;
  logger: Logger;
  cfg: { rangeMinBytes: number; checkpointBytes: number; stallTimeoutMs: number; resumeMarginBytes?: number };
  slotsFor(host: HostConfig): Slots;
  throttleFor(job: JobConfig): Throttle;
  fileGate: { run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> };
  reservations: SpaceReservations;
  onFollowup(jobId: number, atMs: number): void;
  statfs?: Statfs;
  now?: () => number;
  backoff?: DownloadFileRequest["backoff"];
  /** Test hooks: `afterRename` runs after the promote renames and before the ledger commit; `afterJournal` / `afterExtras` run inside promote, before the first extra rename / before the first staged file rename. */
  hooks?: { afterRename?: () => void | Promise<void>; afterJournal?: () => void | Promise<void>; afterExtras?: () => void | Promise<void> };
  sameDevice?: SameDevice;
  /** Wave 2 post actions (extract, chmod, *arr, notifications). Absent: the run behaves as before. */
  post?: PostPipeline;
};

/** Upper bound for delivering a run's notifications (each channel request also has its own timeout). */
const NOTIFY_TIMEOUT_MS = 30_000;

type Tally = { okUnits: number; failedUnits: number; droppedUnits: number; droppedFiles: number };

/** The run executor (plan section 6). Errors are handled only here (run boundary) and per file/unit. */
export function createExecutor(deps: ExecutorDeps): RunJob {
  return (job, runId, signal) => new Execution(deps, job, runId, signal).run();
}

class Execution {
  private session: EngineSession | undefined;
  private readonly warned = new Set<string>();
  private readonly postWarnings: string[] = [];
  private readonly tally: Tally = { okUnits: 0, failedUnits: 0, droppedUnits: 0, droppedFiles: 0 };
  private readonly now: () => number;

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly job: JobConfig,
    private readonly runId: number,
    private readonly signal: AbortSignal,
  ) {
    this.now = deps.now ?? Date.now;
  }

  async run(): Promise<RunState> {
    try {
      try {
        return await this.main();
      } catch (err) {
        return await this.onError(err);
      }
    } finally {
      this.deps.reservations.release(this.runId);
      await this.closeSession();
    }
  }

  private async main(): Promise<RunState> {
    const dryRun = this.dryRun();
    this.note("run", "info", `Run started for ${this.job.name}${dryRun ? " (dry run)" : ""}`);
    this.setState("connecting");
    const session = await this.connect();
    this.setState("listing");
    const listing = await this.listRemote(session);
    this.checkAbort();
    this.setState("planning");
    const plan = this.plan(listing, dryRun);
    if (plan.units.length === 0) {
      if (dryRun) recordDryRun(this.deps.stores, this.runId, plan.skipped, [], []);
      return this.finish("succeeded", "Nothing to do", plan);
    }
    this.setState("awaiting_space");
    const { kept, dropped } = await this.fit(plan.units);
    if (dryRun) recordDryRun(this.deps.stores, this.runId, plan.skipped, kept, dropped);
    this.tally.droppedUnits = dropped.length;
    this.tally.droppedFiles = dropped.reduce((n, u) => n + u.files.length, 0);
    if (kept.length === 0) return this.finish("skipped_space", `Not enough free space for ${dropped.length} unit(s)`, plan);
    if (dryRun) return this.finish("succeeded", "Dry run: nothing downloaded", plan, kept);
    await this.transferAll(kept, session);
    return this.finish(this.terminalState(), "Run finished", plan, kept);
  }

  private async listRemote(session: EngineSession): Promise<RemoteEntry[]> {
    const release = await this.slots!.acquireOne(this.signal);
    try {
      return await session.list(this.job.remotePath, { recurse: true });
    } finally {
      release();
    }
  }

  private dryRun(): boolean {
    const row = this.deps.stores.runs.get(this.runId);
    if (!row) throw new Error(`run ${this.runId} not found`);
    return row.dryRun;
  }

  private async connect(): Promise<EngineSession> {
    const host = this.deps.stores.hosts.getConfig(this.job.hostId);
    this.session = await this.deps.engine.open(host);
    this.slots = this.deps.slotsFor(host);
    return this.session;
  }

  private slots: Slots | undefined;

  private plan(listing: RemoteEntry[], dryRun: boolean): Plan {
    const { stores } = this.deps;
    const plan = planRun({
      job: this.job, listing, ledger: stores.ledger.active(this.job.id), observations: stores.observations.all(this.job.id),
      completedUnits: stores.ledger.completedUnits(this.job.id), now: this.now(),
    });
    for (const w of plan.warnings) this.note("plan", "warn", w);
    if (dryRun) return plan;
    stores.observations.upsert(this.job.id, plan.observations);
    stores.observations.remove(this.job.id, plan.vanished);
    if (plan.followupAt !== null) this.deps.onFollowup(this.job.id, plan.followupAt);
    return plan;
  }

  private async fit(units: PlannedUnit[]): Promise<{ kept: PlannedUnit[]; dropped: PlannedUnit[] }> {
    const fit = await fitToSpace({
      units, localPath: this.job.localPath, minFreeBytes: this.job.minFreeBytes, runId: this.runId,
      reservations: this.deps.reservations, statfs: this.deps.statfs ?? defaultStatfs,
    });
    if (fit.dropped.length > 0) {
      const names = fit.dropped.map((u) => u.key).join(", ");
      this.note("space", "warn", `Skipped ${fit.dropped.length} unit(s) for lack of free space: ${names}`, { dropped: fit.dropped.map((u) => u.key) });
    }
    return fit;
  }

  private async transferAll(kept: PlannedUnit[], session: EngineSession): Promise<void> {
    await ensureStaging(this.job.localPath, this.job.id, this.deps.sameDevice);
    const total = kept.reduce((n, u) => n + u.totalBytes, 0);
    this.deps.stores.runs.setPlanned(this.runId, kept.reduce((n, u) => n + u.files.length, 0), total);
    const ctx = this.makeCtx(session, new Tracker(this.deps.stores.runs, this.deps.bus, this.job.id, this.runId, total));
    let remaining = total;
    for (const unit of kept) {
      this.checkAbort();
      if (await this.stillFits(unit)) await this.runUnit(ctx, unit);
      remaining -= unit.totalBytes;
      this.deps.reservations.set(this.runId, remaining);
    }
  }

  /** Free space is re-checked before EACH unit (other processes and runs consume it); a unit that no longer fits is dropped. */
  private async stillFits(unit: PlannedUnit): Promise<boolean> {
    const { reservations, statfs } = this.deps;
    const fits = await unitFits({ unit, localPath: this.job.localPath, minFreeBytes: this.job.minFreeBytes, runId: this.runId, reservations, statfs: statfs ?? defaultStatfs });
    if (!fits) {
      this.tally.droppedUnits++;
      this.tally.droppedFiles += unit.files.length;
      this.note("space", "warn", `Skipped unit ${unit.key} for lack of free space at transfer time`, { dropped: [unit.key] });
    }
    return fits;
  }

  private async runUnit(ctx: RunCtx, unit: PlannedUnit): Promise<void> {
    const out = await processUnit(ctx, unit);
    if (out.ok) this.tally.okUnits++;
    else this.tally.failedUnits++;
  }

  private makeCtx(session: EngineSession, tracker: Tracker): RunCtx {
    return {
      deps: this.deps, job: this.job, runId: this.runId, session, slots: this.slots!, throttle: this.deps.throttleFor(this.job),
      signal: this.signal, tracker, now: this.now,
      note: (c, s, m, meta) => this.note(c, s, m, meta),
      warnOnce: (key, m) => {
        if (this.warned.has(key)) return;
        this.warned.add(key);
        this.note("warning", "warn", m);
      },
      setState: (s) => this.setState(s),
      postWarn: (m) => {
        this.postWarnings.push(m);
        this.note("post", "warn", m);
      },
    };
  }

  private terminalState(): RunState {
    const { okUnits, failedUnits, droppedUnits } = this.tally;
    if (failedUnits > 0 && okUnits === 0) return "failed";
    return failedUnits > 0 || droppedUnits > 0 || this.postWarnings.length > 0 ? "partial" : "succeeded";
  }

  private checkAbort(): void {
    if (this.signal.aborted) throw abortError(this.signal);
  }

  private async finish(requested: RunState, summary: string, plan: Plan, kept?: PlannedUnit[]): Promise<RunState> {
    const counts: Record<string, number> = {};
    for (const s of plan.skipped) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
    this.deps.stores.runs.addProgress(this.runId, { filesSkipped: plan.skipped.length + this.tally.droppedFiles });
    const state = requested;
    const sev: Severity = state === "failed" ? "error" : state === "partial" || state === "skipped_space" ? "warn" : "info";
    this.note("run", sev, `${summary}: ${state}`, {
      state, ...this.tally, plannedUnits: plan.units.length, keptUnits: kept?.length ?? 0, skipped: counts,
      bytes: (kept ?? plan.units).reduce((n, u) => n + u.totalBytes, 0),
    });
    this.setState(state);
    await this.notify(state);
    return state;
  }

  private async onError(err: unknown): Promise<RunState> {
    if (this.signal.aborted) {
      this.note("run", "warn", "Run cancelled; partial downloads are kept for resume");
      this.setState("cancelled");
      await this.notify("cancelled");
      return "cancelled";
    }
    const msg = err instanceof Error ? err.message : String(err);
    this.deps.logger.error({ err, runId: this.runId, jobId: this.job.id }, "run failed");
    if (err instanceof HostKeyChanged) this.note("host-key", "error", `Host key changed for host ${this.job.hostId}: ${msg}`);
    this.note("run", "error", `Run failed: ${msg}`, { fatal: isFatal(err) });
    this.setState("failed", msg);
    await this.notify("failed");
    return "failed";
  }

  /**
   * Notifications run AFTER the terminal state is stored (the run store keeps a terminal state final), so a flaky channel can
   * never change the outcome: delivery problems are activity entries only. Dry runs and "nothing to do" runs never notify.
   */
  private async notify(state: RunState): Promise<void> {
    const { post, stores } = this.deps;
    const row = stores.runs.get(this.runId);
    if (!post || !row || row.dryRun || (state === "succeeded" && row.filesPlanned === 0)) return;
    const finished = row.finishedAt ?? this.now();
    const res = await post.afterRun({
      job: this.job, runId: this.runId, state, signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      summary: {
        filesOk: row.filesOk, filesFailed: row.filesFailed, filesSkipped: row.filesSkipped, bytesDone: row.bytesDone,
        durationMs: Math.max(0, finished - (row.startedAt ?? finished)), error: row.error, warnings: [...this.postWarnings],
      },
    }).catch((err: unknown) => ({ warnings: [`notifications failed: ${err instanceof Error ? err.message : String(err)}`] }));
    for (const w of res.warnings) this.note("notify", "warn", w);
  }

  private async closeSession(): Promise<void> {
    try {
      await this.session?.close();
    } catch (err) {
      this.deps.logger.warn({ err, runId: this.runId }, "closing engine session failed");
    }
  }

  private setState(state: RunState, error?: string): void {
    const { stores, bus } = this.deps;
    if (stores.runs.get(this.runId)?.state === state) return;
    stores.runs.setState(this.runId, state, error);
    bus.emit({ type: "run.state", runId: this.runId, jobId: this.job.id, state });
  }

  private note(category: string, severity: Severity, summary: string, meta?: unknown): void {
    const { stores, bus } = this.deps;
    stores.activity.record({ category, severity, jobId: this.job.id, runId: this.runId, summary, meta });
    const last = stores.activity.list({ limit: 1 })[0];
    if (last) bus.emit({ type: "activity", id: last.id });
  }
}
