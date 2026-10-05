import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { testArr, type ArrTestResult } from "../post/arr.js";
import { explainError } from "../post/explain.js";
import type { ArrPublic } from "../store/arr-store.js";
import type { AppDeps } from "./deps.js";
import { parseId, type FormErrors } from "./host-schemas.js";
import { redirectTo, render, renderFragment } from "./helpers.js";
import { arrValues, parseArrForm } from "./integration-schemas.js";

const KEY_UNREADABLE = "The stored API key cannot be decrypted (APP_SECRET changed). Enter the API key again and save.";
type IdReq = FastifyRequest<{ Params: { id: string } }>;

const nameTaken = (deps: AppDeps, name: string, exceptId: number | null): boolean =>
  deps.stores.arrTargets.listPublic().some((t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase());

function renderForm(reply: FastifyReply, deps: AppDeps, target: ArrPublic | null, values: Record<string, string>, errors: FormErrors, status = 200) {
  const data = {
    title: target ? `Target ${target.name}` : "New *arr target", nav: "arr", target, values, errors,
    action: target ? `/arr-targets/${target.id}` : "/arr-targets", usedBy: target ? deps.stores.arrTargets.usedBy(target.id) : [],
  };
  return render(reply, deps, "arr-form.eta", data, status);
}

function findTarget(req: IdReq, deps: AppDeps): ArrPublic | undefined {
  const id = parseId(req.params.id);
  return id ? deps.stores.arrTargets.getPublic(id) : undefined;
}

async function save(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, existing: ArrPublic | null) {
  const parsed = parseArrForm(req.body, existing === null, existing?.url);
  const values = arrValues(req.body);
  if (!parsed.ok) return renderForm(reply, deps, existing, values, parsed.errors, 400);
  const d = parsed.data;
  if (nameTaken(deps, d.name, existing?.id ?? null)) return renderForm(reply, deps, existing, values, { name: "A target with this name already exists" }, 400);
  if (existing) deps.stores.arrTargets.update(existing.id, d);
  else deps.stores.arrTargets.create(d);
  return redirectTo(reply, "/arr-targets", { kind: "ok", message: `Target "${d.name}" saved.` });
}

function remove(req: IdReq, reply: FastifyReply, deps: AppDeps) {
  const t = findTarget(req, deps);
  if (!t) return reply.callNotFound();
  const jobs = deps.stores.arrTargets.delete(t.id);
  const note = jobs.length > 0 ? ` It was used by ${jobs.length} job(s) (${jobs.join(", ")}); they no longer notify an *arr.` : "";
  return redirectTo(reply, "/arr-targets", { kind: jobs.length > 0 ? "info" : "ok", message: `Target "${t.name}" deleted.${note}` });
}

async function runTest(deps: AppDeps, id: number): Promise<ArrTestResult> {
  try {
    return await testArr(deps.stores.arrTargets.getConfig(id));
  } catch (err) {
    return { ok: false, message: explainError(err, deps.logger, { arrTargetId: id }, KEY_UNREADABLE) };
  }
}

async function test(req: IdReq, reply: FastifyReply, deps: AppDeps) {
  const t = findTarget(req, deps);
  if (!t) return reply.callNotFound();
  const result = await runTest(deps, t.id);
  if (req.headers["hx-request"] === "true") return renderFragment(reply, deps, "partials/integration-test-result.eta", { result });
  return redirectTo(reply, "/arr-targets", { kind: result.ok ? "ok" : "error", message: `${t.name}: ${result.message}` });
}

export function registerArrRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/arr-targets", async (_req, reply) => {
    const targets = deps.stores.arrTargets.listPublic().map((t) => ({ ...t, jobCount: deps.stores.arrTargets.usedBy(t.id).length }));
    return render(reply, deps, "arr-targets.eta", { title: "Sonarr / Radarr", nav: "arr", targets });
  });
  app.get("/arr-targets/new", async (_req, reply) => renderForm(reply, deps, null, { name: "", kind: "sonarr", url: "" }, {}));
  app.post("/arr-targets", (req, reply) => save(req, reply, deps, null));
  app.get<{ Params: { id: string } }>("/arr-targets/:id", async (req, reply) => {
    const t = findTarget(req, deps);
    return t ? renderForm(reply, deps, t, { name: t.name, kind: t.kind, url: t.url }, {}) : reply.callNotFound();
  });
  app.post<{ Params: { id: string } }>("/arr-targets/:id", (req, reply) => {
    const t = findTarget(req, deps);
    return t ? save(req, reply, deps, t) : reply.callNotFound();
  });
  app.post<{ Params: { id: string } }>("/arr-targets/:id/delete", async (req, reply) => remove(req, reply, deps));
  app.post<{ Params: { id: string } }>("/arr-targets/:id/test", (req, reply) => test(req, reply, deps));
}
