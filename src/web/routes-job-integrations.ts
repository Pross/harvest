import type { FastifyInstance, FastifyReply } from "fastify";
import { NOTIFY_ON, type JobIntegration } from "../store/integration-store.js";
import type { AppDeps } from "./deps.js";
import { bodyStrings, parseId, type FormErrors } from "./host-schemas.js";
import { redirectTo, render } from "./helpers.js";
import { parseJobIntegration } from "./integration-schemas.js";

const NOTIFY_LABELS: Record<(typeof NOTIFY_ON)[number], string> = {
  never: "Never", failure: "On failure (failed, partial, or out-of-space runs; also runs that could not start)", success: "On success (runs that transferred files; not runs with nothing to do)", always: "Always (every finished run that did something, plus cancelled, locked and out-of-space runs)",
};

function renderPage(reply: FastifyReply, deps: AppDeps, jobId: number, v: JobIntegration, errors: FormErrors, status = 200) {
  const job = deps.stores.jobs.get(jobId);
  const data = {
    title: `Integrations: ${job?.name ?? ""}`, nav: "jobs", job, v, errors, targets: deps.stores.arrTargets.listPublic(),
    channels: deps.stores.channels.listPublic(), notifyOptions: NOTIFY_ON.map((value) => ({ value, label: NOTIFY_LABELS[value] })),
  };
  return render(reply, deps, "job-integrations.eta", data, status);
}

/** The posted choices, so a validation error does not discard what the user typed. */
function postedValues(body: unknown, fallback: JobIntegration): JobIntegration {
  const b = bodyStrings(body);
  const ids = (Array.isArray((body as Record<string, unknown> | null)?.["channel"]) ? ((body as Record<string, unknown>)["channel"] as unknown[]) : [(body as Record<string, unknown> | null)?.["channel"]])
    .filter((x): x is string => typeof x === "string").map(Number).filter(Number.isInteger);
  const arr = Number(b["arr_target_id"]);
  return { arrTargetId: Number.isInteger(arr) && arr > 0 ? arr : null, arrPath: b["arr_path"] ?? "", notifyOn: (NOTIFY_ON as readonly string[]).includes(b["notify_on"] ?? "") ? (b["notify_on"] as JobIntegration["notifyOn"]) : fallback.notifyOn, notifyChannelIds: ids };
}

export function registerJobIntegrationRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { id: string } }>("/jobs/:id/integrations", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id || !deps.stores.jobs.get(id)) return reply.callNotFound();
    return renderPage(reply, deps, id, deps.stores.integrations.get(id), {});
  });
  app.post<{ Params: { id: string } }>("/jobs/:id/integrations", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id || !deps.stores.jobs.get(id)) return reply.callNotFound();
    const known = {
      arr: new Set(deps.stores.arrTargets.listPublic().map((t) => t.id)),
      channels: new Set(deps.stores.channels.listPublic().map((c) => c.id)),
    };
    const parsed = parseJobIntegration(req.body, known);
    if (!parsed.ok) return renderPage(reply, deps, id, postedValues(req.body, deps.stores.integrations.get(id)), parsed.errors, 400);
    deps.stores.integrations.set(id, parsed.data);
    return redirectTo(reply, `/jobs/${id}`, { kind: "ok", message: "Integrations saved." });
  });
}
