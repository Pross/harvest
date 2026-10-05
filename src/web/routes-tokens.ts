import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { JobConfig } from "../domain.js";
import type { AppDeps } from "./deps.js";
import { formatTime } from "./format.js";
import { parseId } from "./host-schemas.js";
import { redirectTo, render, renderFragment } from "./helpers.js";
import { webhookSnippets } from "./webhook-snippets.js";

const CreateBody = z.object({ name: z.string().trim().min(1, "Enter a name.").max(60, "Use at most 60 characters.") });
type Params = { Params: { id: string; tokenId?: string } };
type Extra = { newToken?: string; errors?: Record<string, string>; values?: Record<string, string> };

const baseUrl = (req: FastifyRequest, deps: AppDeps): string =>
  (deps.config.PUBLIC_URL ?? `${req.protocol}://${req.host}`).replace(/\/+$/, "");

function webhookData(req: FastifyRequest, deps: AppDeps, job: JobConfig, extra: Extra) {
  const hookUrl = `${baseUrl(req, deps)}/hooks/jobs/${job.id}`;
  const tokens = deps.stores.tokens.listForJob(job.id).map((t) => ({
    id: t.id, name: t.name, createdHtml: formatTime(t.createdAt), lastUsedHtml: t.lastUsedAt === null ? "never" : formatTime(t.lastUsedAt),
  }));
  return {
    nav: "jobs", job, hookUrl, tokens, newToken: extra.newToken ?? null, errors: extra.errors ?? {}, values: extra.values ?? {},
    snippets: webhookSnippets(hookUrl, extra.newToken ?? "YOUR_TOKEN"),
  };
}

function jobFor(deps: AppDeps, raw: string): JobConfig | undefined {
  const id = parseId(raw);
  return id === null ? undefined : deps.stores.jobs.get(id);
}

function page(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, job: JobConfig, extra: Extra = {}, status = 200) {
  return render(reply, deps, "webhook.eta", { title: `Webhook: ${job.name}`, ...webhookData(req, deps, job, extra) }, status);
}

async function createToken(req: FastifyRequest<Params>, reply: FastifyReply, deps: AppDeps) {
  const job = jobFor(deps, req.params.id);
  if (!job) return reply.callNotFound();
  const parsed = CreateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Enter a name.";
    const raw = (req.body as Record<string, unknown> | undefined)?.["name"];
    return page(req, reply, deps, job, { errors: { name: message }, values: { name: typeof raw === "string" ? raw.slice(0, 60) : "" } }, 400);
  }
  const { token, record } = deps.stores.tokens.create(job.id, parsed.data.name);
  deps.logger.info({ jobId: job.id, tokenId: record.id }, "Webhook token created");
  return page(req, reply, deps, job, { newToken: token });
}

async function revokeToken(req: FastifyRequest<Params>, reply: FastifyReply, deps: AppDeps) {
  const job = jobFor(deps, req.params.id);
  const tokenId = parseId(req.params.tokenId ?? "");
  if (!job || tokenId === null) return reply.callNotFound();
  const removed = deps.stores.tokens.revoke(job.id, tokenId);
  if (removed) deps.logger.info({ jobId: job.id, tokenId }, "Webhook token revoked");
  const flash = removed ? { kind: "ok" as const, message: "Token revoked." } : { kind: "error" as const, message: "Token not found." };
  return redirectTo(reply, `/jobs/${job.id}/webhook`, flash);
}

export function registerTokenRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get<Params>("/jobs/:id/webhook", async (req, reply) => {
    const job = jobFor(deps, req.params.id);
    return job ? page(req, reply, deps, job) : reply.callNotFound();
  });
  app.get<Params>("/jobs/:id/webhook/panel", async (req, reply) => {
    const job = jobFor(deps, req.params.id);
    return job ? renderFragment(reply, deps, "partials/webhook.eta", webhookData(req, deps, job, {})) : reply.callNotFound();
  });
  app.post<Params>("/jobs/:id/tokens", (req, reply) => createToken(req, reply, deps));
  app.post<Params>("/jobs/:id/tokens/:tokenId/revoke", (req, reply) => revokeToken(req, reply, deps));
}
