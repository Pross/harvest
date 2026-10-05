import type { Throttle } from "./types.js";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type RateThrottle = Throttle & { setRate(bytesPerSec: number | null): void };
export type ThrottleOptions = { bytesPerSec: number | null; now?: () => number; sleep?: Sleep };

/** The error used when an AbortSignal stops a wait: the signal's own Error reason, else a plain AbortError. */
export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const normalize = (bps: number | null): number => (bps === null || !(bps > 0) ? 0 : bps);

/**
 * Token bucket: capacity is one second of tokens, so bursts are bounded to ~1 s. `take` reserves its
 * bytes immediately (the bucket may go into debt for chunks larger than the capacity) and sleeps for
 * the time the debt needs to be repaid. Rate 0 (or null) means unlimited.
 */
export function createThrottle(opts: ThrottleOptions): RateThrottle {
  return new TokenBucket(normalize(opts.bytesPerSec), opts.now ?? (() => performance.now()), opts.sleep ?? defaultSleep);
}

/** One reserved `take` that is still paying off its debt. `wake` interrupts its sleep so it re-evaluates. */
type Waiter = { bytes: number; wake: () => void };

class TokenBucket implements RateThrottle {
  private tokens: number;
  private last: number;
  /** In reservation order, so a waiter's own level is the bucket level plus the bytes reserved after it. */
  private readonly waiters: Waiter[] = [];

  constructor(
    private rate: number,
    private readonly now: () => number,
    private readonly sleep: Sleep,
  ) {
    this.tokens = rate;
    this.last = now();
  }

  /** Waiting takes are woken and re-evaluate their remaining wait against the new rate. */
  setRate(bps: number | null): void {
    this.refill();
    const was = this.rate;
    this.rate = normalize(bps);
    this.tokens = this.rate === 0 ? 0 : was === 0 ? this.rate : Math.min(this.tokens, this.rate);
    for (const w of [...this.waiters]) w.wake();
  }

  async take(bytes: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.rate === 0 || bytes <= 0) return;
    this.refill();
    this.tokens -= bytes;
    if (this.tokens >= 0) return;
    const waiter: Waiter = { bytes, wake: () => {} };
    this.waiters.push(waiter);
    try {
      await this.payOff(waiter, signal);
    } catch (err) {
      this.tokens += bytes;
      throw err;
    } finally {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
    }
  }

  private async payOff(waiter: Waiter, signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.refill();
      const level = this.tokens + this.reservedAfter(waiter);
      if (this.rate === 0 || level >= -1e-6) return;
      const ctl = new AbortController();
      waiter.wake = () => ctl.abort();
      try {
        await this.sleep((-level / this.rate) * 1000, signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal);
      } catch (err) {
        if (signal?.aborted || !ctl.signal.aborted) throw err;
      }
    }
  }

  private reservedAfter(waiter: Waiter): number {
    let sum = 0;
    for (let i = this.waiters.length - 1; i >= 0 && this.waiters[i] !== waiter; i--) sum += this.waiters[i]!.bytes;
    return sum;
  }

  private refill(): void {
    const t = this.now();
    if (this.rate > 0) this.tokens = Math.min(this.rate, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
  }
}

/** Takes from each throttle in order (job bucket first, then the global bucket). */
export function composeThrottles(...ts: Throttle[]): Throttle {
  return {
    async take(bytes, signal) {
      for (const t of ts) await t.take(bytes, signal);
    },
  };
}
