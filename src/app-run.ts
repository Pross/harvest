import { PermanentError } from "./errors.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { HostConfig, JobConfig } from "./domain.js";
import type { TransferEngine } from "./engine/types.js";
import { resolveGlobalRate, type BwSettings } from "./run/bandwidth.js";
import { createBandwidthScheduler, type BandwidthScheduler } from "./run/bandwidth-scheduler.js";
import { createArrStep } from "./post/arr.js";
import { createDefaultPostPipeline } from "./post/index.js";
import { createEarlyNotifier } from "./post/notify/early.js";
import { createRunNotifier } from "./post/notify/index.js";
import { createEventBus, type EventBus } from "./run/events.js";
import { createExecutor } from "./run/executor.js";
import { createGate } from "./run/gate.js";
import { createRunManager, type ManagedRunManager } from "./run/manager.js";
import type { RunJob } from "./run/manager-types.js";
import { createSlots, type Slots } from "./run/connection-slots.js";
import { createSpaceReservations } from "./run/space.js";
import { composeThrottles, createThrottle, type RateThrottle } from "./run/throttle.js";
import type { Stores } from "./store/index.js";
import { validateLocalPath } from "./web/local-browse.js";
import { DEFAULT_SETTINGS } from "./web/settings-schema.js";

/** One connection pool per host, rebuilt when the host's cap changes. Shared by the executor and maintenance. */
export function createSlotsRegistry(): (host: { id: number; maxConnections: number }) => Slots {
  const pools = new Map<number, { max: number; slots: Slots }>();
  return (host) => {
    const hit = pools.get(host.id);
    if (hit && hit.max === host.maxConnections) return hit.slots;
    const slots = createSlots(host.maxConnections);
    pools.set(host.id, { max: host.maxConnections, slots });
    return slots;
  };
}

export type RunPipeline = {
  bus: EventBus;
  manager: ManagedRunManager;
  globalThrottle: RateThrottle;
  /** Applies the time-of-day bandwidth profiles to globalThrottle. Call refresh() to start and after settings change. */
  bandwidth: BandwidthScheduler;
  slotsFor: ReturnType<typeof createSlotsRegistry>;
};

type PipelineInput = { config: Config; stores: Stores; engine: TransferEngine; logger: Logger; readBandwidth: () => BwSettings };

/** The job's local path is re-validated at run start (symlinks may have changed) and the real path is used. */
function withValidatedPath(config: Config, inner: RunJob): RunJob {
  return async (job, runId, signal) => {
    const check = await validateLocalPath(job.localPath, config);
    if (!check.ok) throw new PermanentError(`local path rejected: ${check.error}`);
    return inner({ ...job, localPath: check.path }, runId, signal);
  };
}

/** Corrupt stored settings must not stop the app from booting: warn and start unlimited (the scheduler retries the read). */
function initialRate(i: PipelineInput): number | null {
  try {
    return resolveGlobalRate(i.readBandwidth(), new Date());
  } catch (err) {
    i.logger.warn({ err }, "Stored bandwidth settings are invalid; starting with the default rate");
    return resolveGlobalRate(DEFAULT_SETTINGS, new Date());
  }
}

export function buildRunPipeline(i: PipelineInput): RunPipeline {
  const bus = createEventBus();
  const globalThrottle = createThrottle({ bytesPerSec: initialRate(i) });
  const bandwidth = createBandwidthScheduler({ throttle: globalThrottle, read: i.readBandwidth, logger: i.logger });
  const slotsFor = createSlotsRegistry();
  let manager: ManagedRunManager | undefined;
  const notifier = createRunNotifier(i.stores, i.logger);
  const executor = createExecutor({
    engine: i.engine, stores: i.stores, bus, logger: i.logger,
    cfg: { rangeMinBytes: i.config.RANGE_MIN_BYTES, checkpointBytes: i.config.CHECKPOINT_BYTES, stallTimeoutMs: i.config.STALL_TIMEOUT_SECONDS * 1000 },
    slotsFor: (host: HostConfig) => slotsFor(host),
    throttleFor: (job: JobConfig) => composeThrottles(createThrottle({ bytesPerSec: job.bwlimitBps }), globalThrottle),
    fileGate: createGate(i.config.MAX_CONCURRENT_FILES),
    reservations: createSpaceReservations(),
    onFollowup: (jobId, atMs) => manager?.scheduleFollowup(jobId, atMs),
    post: createDefaultPostPipeline({ postStore: i.stores.post, logger: i.logger, arr: createArrStep({ stores: i.stores, logger: i.logger }), notifier }),
  });
  manager = createRunManager({
    runJob: withValidatedPath(i.config, executor), stores: i.stores, bus, logger: i.logger,
    maxConcurrentRuns: i.config.MAX_CONCURRENT_RUNS, notifyEnd: createEarlyNotifier(notifier, i.stores, i.logger),
  });
  return { bus, manager, globalThrottle, bandwidth, slotsFor };
}
