import type { FastifyInstance } from "fastify";
import type { JobConfig } from "../domain.js";
import { ALLOW_LARGE_TTL_MS, largeAllowed } from "../run/mirror-sweep.js";
import type { AppDeps } from "./deps.js";
import { formatAbsolute } from "./format.js";
import { redirectTo } from "./helpers.js";
import { bodyStrings, parseId } from "./host-schemas.js";

/** What the job page shows about the one-shot permission to delete past the mirror safety limits. */
export function mirrorAllowInfo(job: JobConfig, now = Date.now()): { active: boolean; until: string } {
  const active = largeAllowed(job, now);
  return { active, until: active && job.mirrorAllowLargeAt !== null ? formatAbsolute(job.mirrorAllowLargeAt + ALLOW_LARGE_TTL_MS) : "" };
}

/**
 * Mirror refuses to delete when the remote listing is empty or most of the ledger is gone. These routes give and revoke
 * a one-shot, expiring permission for the next real run to delete anyway (the run consumes it).
 */
export function registerJobMirrorRoutes(app: FastifyInstance, deps: AppDeps): void {
  const jobOf = (raw: string): JobConfig | undefined => {
    const id = parseId(raw);
    return id ? deps.stores.jobs.get(id) : undefined;
  };
  app.post<{ Params: { id: string } }>("/jobs/:id/mirror-allow", async (req, reply) => {
    const job = jobOf(req.params.id);
    if (!job) return reply.callNotFound();
    const back = `/jobs/${job.id}`;
    if (job.mode !== "mirror") return redirectTo(reply, back, { kind: "error", message: "Only mirror jobs have safety limits to allow past." });
    if (!["on", "1", "true"].includes(bodyStrings(req.body)["confirm"] ?? "")) {
      return redirectTo(reply, back, { kind: "error", message: "Tick the box to confirm. Nothing was allowed." });
    }
    deps.stores.jobs.update(job.id, { mirrorAllowLargeAt: Date.now() });
    return redirectTo(reply, back, { kind: "ok", message: "Allowed for the next real run (valid for 24 hours). Run a dry run first to review what it would delete." });
  });
  app.post<{ Params: { id: string } }>("/jobs/:id/mirror-disallow", async (req, reply) => {
    const job = jobOf(req.params.id);
    if (!job) return reply.callNotFound();
    deps.stores.jobs.update(job.id, { mirrorAllowLargeAt: null });
    return redirectTo(reply, `/jobs/${job.id}`, { kind: "ok", message: "Permission cancelled. The safety limits apply again." });
  });
}
