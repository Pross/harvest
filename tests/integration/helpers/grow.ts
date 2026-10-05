import { exec, type Service } from "./compose.js";
import { REMOTE_ROOT } from "./seed.js";

export type Grower = { stop: () => Promise<void>; appended: () => number };

/**
 * Append `bytes` of data to `<root>/<relPath>` every `everyMs` until `durationMs` elapses or stop() is called.
 * Each append is one `docker compose exec`, so keep everyMs >= 500. The file is created if missing.
 */
export function growFile(service: Service, relPath: string, bytes: number, everyMs: number, durationMs: number): Grower {
  const remote = `${REMOTE_ROOT[service]}/${relPath}`;
  const deadline = Date.now() + durationMs;
  let total = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped || Date.now() >= deadline) return;
    inflight = exec(service, ["sh", "-c", `head -c ${bytes} /dev/urandom >> '${remote}' && chmod a+rw '${remote}'`], 30_000)
      .then(() => { total += bytes; })
      .catch(() => undefined);
    timer = setTimeout(tick, everyMs);
  };
  tick();
  return {
    appended: () => total,
    stop: async () => { stopped = true; if (timer) clearTimeout(timer); await inflight; },
  };
}
