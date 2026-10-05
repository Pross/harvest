import { abortError } from "./throttle.js";

/** Counting semaphore: at most `max` concurrent `run` callbacks, FIFO. Used for the global MAX_CONCURRENT_FILES cap. */
export interface Gate {
  /** With `signal`, a queued waiter stops waiting (rejects with the abort error) when it aborts. */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createGate(max: number): Gate {
  if (!Number.isInteger(max) || max < 1) throw new Error(`invalid gate size: ${max}`);
  return new CountingGate(max);
}

class CountingGate implements Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** A freed slot goes straight to the next waiter (active stays), so a newcomer cannot overtake it. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiting.splice(this.waiting.indexOf(grant), 1);
        reject(abortError(signal!));
      };
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(grant);
    });
  }
}
