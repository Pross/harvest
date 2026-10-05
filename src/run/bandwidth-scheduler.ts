import type { Logger } from "../logger.js";
import { nextBoundary, resolveGlobalRate, type BwSettings } from "./bandwidth.js";

export type BandwidthScheduler = {
  /** Re-reads settings, applies the current rate and re-arms the timer for the next profile boundary. */
  refresh(): void;
  /** The rate applied by the last refresh (null = unlimited). */
  current(): number | null;
  stop(): void;
};

export type BandwidthSchedulerDeps = {
  throttle: { setRate(bps: number | null): void };
  read: () => BwSettings;
  logger: Logger;
  now?: () => Date;
};

/** setTimeout accepts at most 2^31-1 ms; boundaries are at most a week away, but clamp anyway. */
const MAX_DELAY_MS = 2_147_483_647;

/** Retry delay after a failed refresh, and the periodic re-evaluation guard against clock jumps and DST shifts. */
export const RETRY_MS = 60_000;
export const GUARD_MS = 15 * 60_000;

/** Applies the rate for `now` and returns the delay in ms until the next profile boundary (null = none). */
function applyRate(d: BandwidthSchedulerDeps, now: Date): { rate: number | null; delay: number | null } {
  const settings = d.read();
  const rate = resolveGlobalRate(settings, now);
  d.throttle.setRate(rate);
  const next = nextBoundary(settings.bwProfiles, now);
  return { rate, delay: next === null ? null : Math.min(MAX_DELAY_MS, Math.max(1, next - now.getTime())) };
}

class Scheduler implements BandwidthScheduler {
  private timer: NodeJS.Timeout | undefined;
  private guard: NodeJS.Timeout | undefined;
  private rate: number | null = null;
  private stopped = false;

  constructor(private readonly d: BandwidthSchedulerDeps) {}

  current(): number | null {
    return this.rate;
  }

  /** The first call also starts the 15-minute guard tick. */
  refresh(): void {
    if (this.stopped) return;
    if (!this.guard) {
      this.guard = setInterval(() => this.apply(), GUARD_MS);
      this.guard.unref();
    }
    this.apply();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    if (this.guard) clearInterval(this.guard);
    this.guard = undefined;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(ms: number): void {
    this.timer = setTimeout(() => this.apply(), ms);
    this.timer.unref();
  }

  private apply(): void {
    this.clearTimer();
    if (this.stopped) return;
    try {
      const applied = applyRate(this.d, (this.d.now ?? (() => new Date()))());
      this.rate = applied.rate;
      if (applied.delay !== null) this.arm(applied.delay);
    } catch (err) {
      this.d.logger.error({ err }, "applying bandwidth profiles failed; keeping the previous global rate and retrying in 60 s");
      this.arm(RETRY_MS);
    }
  }
}

/**
 * Keeps the global throttle's rate in step with the time-of-day profiles. A failure reading settings is logged at this
 * boundary, the previous rate stays in force and a 60 s retry is armed; a 15-minute tick also re-evaluates the profiles
 * to catch clock jumps and DST shifts. `stop()` clears both timers.
 */
export function createBandwidthScheduler(d: BandwidthSchedulerDeps): BandwidthScheduler {
  return new Scheduler(d);
}
