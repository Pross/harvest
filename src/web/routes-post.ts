import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { JobConfig } from "../domain.js";
import type { AppDeps } from "./deps.js";
import { parseId } from "./host-schemas.js";
import { redirectTo, render, renderFragment } from "./helpers.js";
import { formOf, parsePostForm, type PostForm } from "./post-schema.js";

type Params = { Params: { id: string } };
type View = { values: PostForm; errors: Record<string, string>; saved?: boolean };

function jobFor(deps: AppDeps, raw: string): JobConfig | undefined {
  const id = parseId(raw);
  return id === null ? undefined : deps.stores.jobs.get(id);
}

const data = (job: JobConfig, v: View) => ({ nav: "jobs", title: `Post-actions: ${job.name}`, job, saved: v.saved ?? false, values: v.values, errors: v.errors });

const isHtmx = (req: FastifyRequest): boolean => req.headers["hx-request"] === "true";

async function save(req: FastifyRequest<Params>, reply: FastifyReply, deps: AppDeps) {
  const job = jobFor(deps, req.params.id);
  if (!job) return reply.callNotFound();
  const parsed = parsePostForm(req.body);
  if (!parsed.ok) {
    const view = data(job, { values: parsed.values, errors: parsed.errors });
    // htmx does not swap 4xx responses by default, so the fragment with inline errors is sent with 200.
    return isHtmx(req) ? renderFragment(reply, deps, "partials/post-actions.eta", view) : render(reply, deps, "post-actions.eta", view, 400);
  }
  deps.stores.post.set(job.id, parsed.config);
  deps.logger.info({ jobId: job.id, extract: parsed.config.extract }, "Post-actions saved");
  if (!isHtmx(req)) return redirectTo(reply, `/jobs/${job.id}/post-actions`, { kind: "ok", message: "Post-actions saved." });
  return renderFragment(reply, deps, "partials/post-actions.eta", data(job, { values: formOf(parsed.config), errors: {}, saved: true }));
}

export function registerPostRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<Params>("/jobs/:id/post-actions", async (req, reply) => {
    const job = jobFor(deps, req.params.id);
    if (!job) return reply.callNotFound();
    return render(reply, deps, "post-actions.eta", data(job, { values: formOf(deps.stores.post.get(job.id)), errors: {} }));
  });
  app.post<Params>("/jobs/:id/post-actions", (req, reply) => save(req, reply, deps));
}
