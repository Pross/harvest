import type { FastifyInstance } from "fastify";
import type { TriggerResult } from "../run/manager-types.js";
import type { AppDeps } from "./deps.js";
import { redirectTo } from "./helpers.js";
import { parseId } from "./host-schemas.js";

const messageFor = (r: TriggerResult): { kind: "ok" | "info" | "error"; message: string } => {
  switch (r.status) {
    case "started": case "queued": return { kind: "ok", message: `Dry run #${r.runId} ${r.status === "queued" ? "queued" : "started"}. Nothing will be downloaded or changed.` };
    case "disabled": return { kind: "error", message: "This job is disabled. Enable it first." };
    default: return { kind: "info", message: "This job is already running, so the dry run was skipped." };
  }
};

export function registerDryRunRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post<{ Params: { id: string } }>("/jobs/:id/dry-run", async (req, reply) => {
    const id = parseId(req.params.id);
    const job = id ? deps.stores.jobs.get(id) : undefined;
    if (!job) return reply.callNotFound();
    const result = deps.manager.trigger(job.id, "manual", { dryRun: true });
    const started = result.status === "started" || result.status === "queued";
    return redirectTo(reply, started ? `/runs/${result.runId}` : `/jobs/${job.id}`, messageFor(result));
  });
}
