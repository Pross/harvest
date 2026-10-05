import { PermanentError } from "../errors.js";
import { abortError } from "./throttle.js";

export type Release = () => void;
export type Grant = { count: number; release: Release };

/** Per-host connection semaphore. Files draw from `capacity` (max - reserved); list/stat/delete/move may use any slot. */
export interface Slots {
  /** Most slots a single file can ever hold. */
  readonly capacity: number;
  /** Atomic: waits until all `n` are free at once, so a waiter never holds a partial allotment. */
  acquire(n: number, signal: AbortSignal): Promise<Release>;
  /** One slot for a non-transfer operation; may use the reserved slot. */
  acquireOne(signal: AbortSignal): Promise<Release>;
  /** Waits until at least one file slot is free, then takes min(wanted, free). count is always >= 1. */
  grant(wanted: number, signal: AbortSignal): Promise<Grant>;
  /** Slots a file could take right now. */
  freeForFiles(): number;
}

type Kind = "all" | "upto" | "one";
type Waiter = { kind: Kind; n: number; settle: (g: Grant) => void };

export function createSlots(max: number, reserved = 1): Slots {
  if (!Number.isInteger(max) || max < 1) throw new PermanentError(`invalid connection cap: ${max}`);
  return new SlotPool(max, Math.max(1, max - reserved));
}

class SlotPool implements Slots {
  private used = 0;
  private fileUsed = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly max: number,
    readonly capacity: number,
  ) {}

  freeForFiles = (): number => Math.min(this.capacity - this.fileUsed, this.max - this.used);

  async acquire(n: number, signal: AbortSignal): Promise<Release> {
    this.checkN(n);
    return (await this.enqueue("all", n, signal)).release;
  }

  async acquireOne(signal: AbortSignal): Promise<Release> {
    return (await this.enqueue("one", 1, signal)).release;
  }

  grant(wanted: number, signal: AbortSignal): Promise<Grant> {
    const n = Math.max(1, Math.min(wanted, this.capacity));
    return this.enqueue("upto", n, signal);
  }

  private checkN(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > this.capacity) {
      throw new PermanentError(`cannot acquire ${n} slots (file capacity ${this.capacity})`);
    }
  }

  private takeFor(w: Waiter, fileBlocked: boolean): number {
    if (w.kind === "one") return this.used < this.max ? 1 : 0;
    if (fileBlocked) return 0;
    const free = this.freeForFiles();
    return w.kind === "all" ? (free >= w.n ? w.n : 0) : Math.min(w.n, free);
  }

  /** FIFO per kind: a blocked file waiter blocks later file waiters, but not single-slot operations. */
  private pump(): void {
    let fileBlocked = false;
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i]!;
      const count = this.takeFor(w, fileBlocked);
      if (count === 0) {
        if (w.kind !== "one") fileBlocked = true;
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.used += count;
      if (w.kind !== "one") this.fileUsed += count;
      w.settle({ count, release: this.releaser(w.kind, count) });
    }
  }

  private releaser(kind: Kind, count: number): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.used -= count;
      if (kind !== "one") this.fileUsed -= count;
      this.pump();
    };
  }

  private enqueue(kind: Kind, n: number, signal: AbortSignal): Promise<Grant> {
    return new Promise<Grant>((resolve, reject) => {
      if (signal.aborted) return reject(abortError(signal));
      const onAbort = (): void => {
        const at = this.queue.indexOf(w);
        if (at >= 0) this.queue.splice(at, 1);
        reject(abortError(signal));
        this.pump();
      };
      const w: Waiter = {
        kind,
        n,
        settle: (g) => {
          signal.removeEventListener("abort", onAbort);
          resolve(g);
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(w);
      this.pump();
    });
  }
}
