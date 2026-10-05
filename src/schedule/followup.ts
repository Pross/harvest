/** Seam between the executor (which asks for a follow-up) and the run manager (which owns the timers). */
export type OnFollowup = (jobId: number, atMs: number) => void;

/** A follow-up is due once the settle window has elapsed: `settleSeconds` after `fromMs`. */
export function followupAt(fromMs: number, settleSeconds: number): number {
  return fromMs + Math.max(0, settleSeconds) * 1000;
}
