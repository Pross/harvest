import type { RunState } from "../domain.js";

/** In-process event bus feeding the SSE stream. Frozen contract for run/, schedule/ and web/. */
export type AppEvent =
  | { type: "run.state"; runId: number; jobId: number; state: RunState }
  | { type: "run.progress"; runId: number; jobId: number; bytesDone: number; bytesTotal: number; speedBps: number; activeFiles: { path: string; bytes: number; total: number }[] }
  | { type: "activity"; id: number }
  | { type: "disk"; jobId: number };

export interface EventBus {
  emit(e: AppEvent): void;
  subscribe(fn: (e: AppEvent) => void): () => void;
}

/** A throwing subscriber never affects the emitter or the other subscribers; `onError` (default: stderr) hears about it. */
export function createEventBus(onError: (err: unknown, e: AppEvent) => void = defaultOnError): EventBus {
  const subs = new Set<(e: AppEvent) => void>();
  return {
    emit(e) {
      for (const fn of [...subs]) {
        try {
          fn(e);
        } catch (err) {
          try {
            onError(err, e);
          } catch {
            // the error reporter itself failed: nothing more can be done
          }
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

function defaultOnError(err: unknown, e: AppEvent): void {
  console.error(`event subscriber failed on ${e.type}:`, err);
}
