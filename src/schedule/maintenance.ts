import path from "node:path";
import { Cron } from "croner";
import type { JobConfig } from "../domain.js";
import type { EngineSession, TransferEngine } from "../engine/types.js";
import type { Logger } from "../logger.js";
import type { Slots } from "../run/connection-slots.js";
import { checkMoveTo, moveToFreeName } from "../run/remote-move.js";
import type { PartialRow } from "../run/types.js";
import type { Stores } from "../store/index.js";
import { cleanStaging } from "./staging-sweep.js";

const DAY = 86_400_000;

/** `runDays` ages out per-file run rows; the run rows themselves (the summaries) live `runSummaryDays` (at least `runDays`). */
export type Retention = { activityDays: number; runDays: number; runSummaryDays: number; observationDays: number; stagingDays: number };
export const DEFAULT_RETENTION: Retention = { activityDays: 90, runDays: 180, runSummaryDays: 730, observationDays: 30, stagingDays: 7 };

export type MaintenanceDeps = {
  stores: Stores;
  engine: TransferEngine;
  logger: Logger;
  /** Connection semaphore for a host (the same pool the executor uses). */
  slotsFor: (host: { id: number; maxConnections: number }) => Slots;
  /** Deletes expired sessions (expires_at < now) and returns the count. Kept out of the stores on purpose. */
  purgeSessions: (now: number) => number;
  /** Partials rows whose updated_at is older than `olderThanMs`. */
  stalePartials: (olderThanMs: number) => PartialRow[];
  /** Jobs with a running or queued run (e.g. manager.busyJobIds). Always combined with the run store's non-terminal runs. */
  busyJobs?: () => Set<number>;
  removeFile?: (p: string) => Promise<void>;
  retention?: Partial<Retention>;
  tz?: string;
  signal?: AbortSignal;
};

export type MaintenanceResult = {
  remoteDone: number; remoteFailed: number; remoteSkipped: number; stagingDiscarded: number;
  activityPurged: number; runFilesPurged: number; runsPurged: number; observationsPurged: number; sessionsPurged: number; errors: number;
};

type Row = { job: JobConfig; remotePath: string; remoteRaw: string | null };

const inFlight = new WeakMap<MaintenanceDeps, Promise<MaintenanceResult>>();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Two overlapping calls for the same deps share one pass (boot run vs. cron run). */
export function runMaintenance(deps: MaintenanceDeps, now: number): Promise<MaintenanceResult> {
  const cur = inFlight.get(deps);
  if (cur) return cur;
  const p = pass(deps, now).finally(() => inFlight.delete(deps));
  inFlight.set(deps, p);
  return p;
}

async function pass(deps: MaintenanceDeps, now: number): Promise<MaintenanceResult> {
  const keep = { ...DEFAULT_RETENTION, ...deps.retention };
  const res: MaintenanceResult = {
    remoteDone: 0, remoteFailed: 0, remoteSkipped: 0, stagingDiscarded: 0,
    activityPurged: 0, runFilesPurged: 0, runsPurged: 0, observationsPurged: 0, sessionsPurged: 0, errors: 0,
  };
  await retryRemoteActions(deps, now, res);
  deps.signal?.throwIfAborted();
  const purgeError = purgeOld(deps, now, keep, res);
  deps.signal?.throwIfAborted();
  await cleanStaging(deps, now, keep.stagingDays, res);
  if (Object.values(res).some((n) => n > 0)) {
    safely(deps, () => void deps.stores.activity.record({ category: "maintenance", severity: res.errors > 0 ? "warn" : "info", summary: `Maintenance: ${summarize(res)}`, meta: res }));
  }
  if (purgeError) throw purgeError.err;
  return res;
}

function summarize(r: MaintenanceResult): string {
  return Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(", ");
}

/** Every purge runs even if an earlier one fails; the first failure is returned so the caller can report it. */
function purgeOld(deps: MaintenanceDeps, now: number, keep: Retention, res: MaintenanceResult): { err: unknown } | undefined {
  const { activity, runs, observations } = deps.stores;
  const summaryDays = Math.max(keep.runSummaryDays, keep.runDays);
  const steps: [string, () => void][] = [
    ["activity", () => { res.activityPurged = activity.purgeOlderThan(now - keep.activityDays * DAY); }],
    ["run files", () => { res.runFilesPurged = runs.purgeFilesOlderThan(now - keep.runDays * DAY); }],
    ["runs", () => { res.runsPurged = runs.purgeOlderThan(now - summaryDays * DAY); }],
    ["observations", () => { res.observationsPurged = observations.purgeOlderThan(now - keep.observationDays * DAY); }],
    ["sessions", () => { res.sessionsPurged = deps.purgeSessions(now); }],
  ];
  let first: { err: unknown } | undefined;
  for (const [what, fn] of steps) {
    try {
      fn();
    } catch (err) {
      res.errors++;
      deps.logger.error({ err, what }, "maintenance purge failed");
      first ??= { err };
    }
  }
  return first;
}

/** Groups due ledger rows by host, so each host gets exactly one engine session. */
async function retryRemoteActions(deps: MaintenanceDeps, now: number, res: MaintenanceResult): Promise<void> {
  const byHost = new Map<number, Row[]>();
  const inactive = new Map<number, { why: string; n: number }>();
  for (const due of deps.stores.ledger.duePendingActions(now)) {
    const job = deps.stores.jobs.get(due.jobId);
    if (!job || !job.enabled) {
      const cur = inactive.get(due.jobId) ?? { why: job ? "disabled" : "deleted", n: 0 };
      inactive.set(due.jobId, { ...cur, n: cur.n + 1 });
      res.remoteSkipped++;
      continue;
    }
    const rows = byHost.get(job.hostId) ?? [];
    rows.push({ job, remotePath: due.remotePath, remoteRaw: due.remoteRaw });
    byHost.set(job.hostId, rows);
  }
  for (const [jobId, { why, n }] of inactive) note(deps, jobId, "info", `${n} remote action(s) skipped: job is ${why}`);
  for (const [hostId, rows] of byHost) {
    try {
      await retryHost(deps, hostId, rows, now, res);
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      res.errors++;
      deps.logger.error({ err, hostId }, "maintenance remote actions failed for host");
      note(deps, rows[0]!.job.id, "warn", `Remote actions for host ${hostId} could not run: ${errText(err)}`);
    }
  }
}

async function retryHost(deps: MaintenanceDeps, hostId: number, rows: Row[], now: number, res: MaintenanceResult): Promise<void> {
  if (!deps.stores.hosts.getPublic(hostId)) {
    for (const r of rows) note(deps, r.job.id, "info", `Remote action for ${r.remotePath} skipped: host was deleted`);
    res.remoteSkipped += rows.length;
    return;
  }
  const host = deps.stores.hosts.getConfig(hostId);
  const session = await deps.engine.open(host);
  try {
    const slots = deps.slotsFor(host);
    for (const r of rows) {
      deps.signal?.throwIfAborted();
      await retryRow(deps, session, slots, r, now, res);
    }
  } finally {
    await session.close();
  }
}

async function retryRow(deps: MaintenanceDeps, s: EngineSession, slots: Slots, row: Row, now: number, res: MaintenanceResult): Promise<void> {
  let release: (() => void) | undefined;
  try {
    release = await slots.acquireOne(deps.signal ?? new AbortController().signal);
    await processRow(deps, s, row, now, res);
  } catch (err) {
    if (deps.signal?.aborted) throw err; // shutting down: the row stays due and the next pass retries it
    res.remoteFailed++;
    note(deps, row.job.id, "warn", `Remote action for ${row.remotePath} failed: ${errText(err)}`);
    safely(deps, () => deps.stores.ledger.markRemoteAction(row.job.id, row.remotePath, "failed", now + DAY));
  } finally {
    release?.();
  }
}

/** Acts only if the ledger row is still active, the job still wants an after-sync action, and the remote file is unchanged. */
async function processRow(deps: MaintenanceDeps, s: EngineSession, row: Row, now: number, res: MaintenanceResult): Promise<void> {
  const { job, remotePath } = row;
  const { ledger } = deps.stores;
  const entry = ledger.get(job.id, remotePath);
  if (!entry) return void (res.remoteSkipped++);
  if (job.afterSync === "keep") {
    ledger.markRemoteAction(job.id, remotePath, "none");
    return void (res.remoteSkipped++);
  }
  const remote = await s.stat(path.posix.join(job.remotePath, row.remoteRaw ?? remotePath));
  if (remote === null) {
    await settleMissing(deps, s, row, res);
  } else if (changedSinceSync(entry, remote)) {
    note(deps, job.id, "warn", `Remote file ${remotePath} changed since it was synced; leaving it alone and not retrying`);
    ledger.markRemoteAction(job.id, remotePath, "skipped");
    res.remoteSkipped++;
  } else {
    await applyAction(s, job, row.remoteRaw ?? remotePath);
    ledger.markRemoteAction(job.id, remotePath, "done");
    res.remoteDone++;
  }
}

/**
 * stat() found nothing. With a known server spelling (or a name whose NFC and NFD forms are identical) that really
 * means gone. Otherwise the server may store the NFD spelling of the NFC key, so only the parent listing can prove
 * the name is absent; without that proof the row stays failed (the thrown error marks it).
 */
async function settleMissing(deps: MaintenanceDeps, s: EngineSession, row: Row, res: MaintenanceResult): Promise<void> {
  const { job, remotePath } = row;
  const ledger = deps.stores.ledger;
  if (row.remoteRaw !== null || remotePath.normalize("NFD") === remotePath) {
    note(deps, job.id, "info", `Remote file ${remotePath} is already gone; marking the action done`);
    ledger.markRemoteAction(job.id, remotePath, "done");
    res.remoteDone++;
    return;
  }
  const dir = path.posix.dirname(remotePath);
  const listing = await s.list(path.posix.join(job.remotePath, dir === "." ? "" : dir), { recurse: false });
  const base = path.posix.basename(remotePath);
  if (listing.some((e) => path.posix.basename(e.path).normalize("NFC") === base)) {
    throw new Error(`remote file ${remotePath} is listed but stat() cannot find it (unknown server spelling); will retry`);
  }
  note(deps, job.id, "warn", `Remote file ${remotePath} is not in its parent listing; skipping the action (server spelling was unknown)`);
  ledger.markRemoteAction(job.id, remotePath, "skipped");
  res.remoteSkipped++;
}

/** Size must always match; mtime must match whenever both sides know it. */
function changedSinceSync(entry: { size: number; mtimeMs: number | null }, remote: { size: number; mtimeMs: number | null }): boolean {
  if (remote.size !== entry.size) return true;
  return remote.mtimeMs !== null && entry.mtimeMs !== null && remote.mtimeMs !== entry.mtimeMs;
}

async function applyAction(s: EngineSession, job: JobConfig, remotePath: string): Promise<void> {
  const full = path.posix.join(job.remotePath, remotePath);
  if (job.afterSync !== "move") return s.remove(full);
  if (!job.moveTo) throw new Error("job is set to move files but has no move target");
  const target = checkMoveTo(job.moveTo, job.remotePath);
  if (!target.ok) throw new Error(`invalid move target ${job.moveTo}: ${target.error}`);
  await moveToFreeName(s, full, path.posix.join(target.path, remotePath));
}

/** Activity and ledger bookkeeping inside recovery paths must never abort the pass. */
function safely(deps: MaintenanceDeps, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    deps.logger.error({ err }, "maintenance bookkeeping failed");
  }
}

function note(deps: MaintenanceDeps, jobId: number, severity: "info" | "warn", summary: string): void {
  safely(deps, () => void deps.stores.activity.record({ category: "maintenance", severity, jobId, summary }));
}

export type StartOptions = { bootDelayMs?: number; now?: () => number };

/**
 * Daily at 03:30 plus once shortly after boot. Returns a stop function that cancels the timers and awaits the
 * in-flight pass. Abort `deps.signal` first to make that pass end promptly (it stops between rows and steps).
 */
export function startMaintenance(deps: MaintenanceDeps, opts: StartOptions = {}): () => Promise<void> {
  const now = opts.now ?? Date.now;
  const run = (): void => {
    runMaintenance(deps, now()).catch((err: unknown) => {
      if (deps.signal?.aborted) return;
      deps.logger.error({ err }, "maintenance failed");
      try {
        deps.stores.activity.record({ category: "maintenance", severity: "error", summary: `Maintenance failed: ${err instanceof Error ? err.message : String(err)}` });
      } catch (inner) {
        deps.logger.error({ err: inner }, "could not record activity");
      }
    });
  };
  const cron = new Cron("30 3 * * *", { name: "maintenance", protect: true, unref: true, timezone: deps.tz }, run);
  const boot = setTimeout(run, opts.bootDelayMs ?? 60_000);
  boot.unref();
  return async () => {
    cron.stop();
    clearTimeout(boot);
    await inFlight.get(deps)?.catch(() => {});
  };
}
