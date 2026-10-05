import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FIELDS } from "../post/notify/config.js";
import { buildEvent, sendToChannel } from "../post/notify/index.js";
import { ConfigUnreadableError } from "../store/errors.js";
import { explainError } from "../post/explain.js";
import type { ChannelKind, ChannelPublic } from "../store/channel-store.js";
import { CHANNEL_KINDS } from "../store/channel-store.js";
import type { AppDeps } from "./deps.js";
import { parseId, type FormErrors } from "./host-schemas.js";
import { redirectTo, render, renderFragment } from "./helpers.js";
import { channelValues, isChannelKind, parseChannelForm, postedChannelValues } from "./integration-schemas.js";

const UNREADABLE = "The stored configuration cannot be decrypted (APP_SECRET changed). Enter the secret fields again and save.";
type IdReq = FastifyRequest<{ Params: { id: string } }>;

const nameTaken = (deps: AppDeps, name: string, exceptId: number | null): boolean =>
  deps.stores.channels.listPublic().some((c) => c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase());

/** Decrypted config, or null when it cannot be read. Used for merging blank secret fields and prefilling non-secrets only. */
function storedConfig(deps: AppDeps, id: number): Record<string, string> | null {
  try {
    return deps.stores.channels.getConfig(id).config;
  } catch (err) {
    if (!(err instanceof ConfigUnreadableError)) throw err;
    deps.logger.warn({ err, channelId: id }, "stored channel config could not be read");
    return null;
  }
}

function renderForm(reply: FastifyReply, deps: AppDeps, o: { channel: ChannelPublic | null; kind: ChannelKind; values: Record<string, string>; enabled: boolean; errors: FormErrors; status?: number }) {
  const stored = o.channel ? storedConfig(deps, o.channel.id) : null;
  const data = {
    title: o.channel ? `Channel ${o.channel.name}` : "New channel", nav: "channels", channel: o.channel, kind: o.kind, fields: FIELDS[o.kind],
    values: o.values, enabled: o.enabled, errors: o.errors, unreadable: !!o.channel && stored === null, unreadableMessage: UNREADABLE,
    action: o.channel ? `/channels/${o.channel.id}` : "/channels", usedBy: o.channel ? deps.stores.channels.usedBy(o.channel.id) : [],
    name: o.values["__name"] ?? o.channel?.name ?? "",
  };
  return render(reply, deps, "channel-form.eta", data, o.status ?? 200);
}

async function save(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, existing: ChannelPublic | null, kind: ChannelKind) {
  const stored = existing ? storedConfig(deps, existing.id) : null;
  const parsed = parseChannelForm(kind, req.body, stored);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const values = { ...postedChannelValues(kind, req.body), __name: typeof body["name"] === "string" ? body["name"] : "" };
  const enabled = body["enabled"] === "on";
  const show = (errors: FormErrors) => renderForm(reply, deps, { channel: existing, kind, values, enabled, errors, status: 400 });
  if (!parsed.ok) return show(parsed.errors);
  if (nameTaken(deps, parsed.data.name, existing?.id ?? null)) return show({ name: "A channel with this name already exists" });
  if (existing) deps.stores.channels.update(existing.id, parsed.data);
  else deps.stores.channels.create({ ...parsed.data, kind });
  return redirectTo(reply, "/channels", { kind: "ok", message: `Channel "${parsed.data.name}" saved.` });
}

function remove(req: IdReq, reply: FastifyReply, deps: AppDeps) {
  const id = parseId(req.params.id);
  const ch = id ? deps.stores.channels.getPublic(id) : undefined;
  if (!id || !ch) return reply.callNotFound();
  const jobs = deps.stores.channels.delete(id);
  const note = jobs.length > 0 ? ` It was removed from ${jobs.length} job(s): ${jobs.join(", ")}.` : "";
  return redirectTo(reply, "/channels", { kind: jobs.length > 0 ? "info" : "ok", message: `Channel "${ch.name}" deleted.${note}` });
}

async function sendTest(req: IdReq, reply: FastifyReply, deps: AppDeps) {
  const id = parseId(req.params.id);
  const ch = id ? deps.stores.channels.getPublic(id) : undefined;
  if (!id || !ch) return reply.callNotFound();
  let result: { ok: boolean; message: string };
  try {
    const event = { ...buildEvent({ name: "test" }, 0, "succeeded", { filesOk: 0, filesFailed: 0, filesSkipped: 0, bytesDone: 0, durationMs: 0, error: null, warnings: [] }), title: "Harvest test", text: "This is a test notification from Harvest.", state: "test" as const };
    await sendToChannel(deps.stores.channels.getConfig(id), event);
    result = { ok: true, message: "Test notification sent." };
  } catch (err) {
    result = { ok: false, message: explainError(err, deps.logger, { channelId: id }, UNREADABLE) };
  }
  if (req.headers["hx-request"] === "true") return renderFragment(reply, deps, "partials/integration-test-result.eta", { result });
  return redirectTo(reply, "/channels", { kind: result.ok ? "ok" : "error", message: `${ch.name}: ${result.message}` });
}

export function registerChannelRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/channels", async (_req, reply) => {
    const channels = deps.stores.channels.listPublic().map((c) => ({ ...c, jobCount: deps.stores.channels.usedBy(c.id).length }));
    return render(reply, deps, "channels.eta", { title: "Notifications", nav: "channels", channels });
  });
  app.get<{ Querystring: { kind?: string } }>("/channels/new", async (req, reply) => {
    const kind = req.query.kind;
    if (!isChannelKind(kind)) return render(reply, deps, "channel-kinds.eta", { title: "New channel", nav: "channels", kinds: CHANNEL_KINDS });
    return renderForm(reply, deps, { channel: null, kind, values: {}, enabled: true, errors: {} });
  });
  app.post<{ Querystring: { kind?: string } }>("/channels", (req, reply) => {
    const kind = req.query.kind;
    return isChannelKind(kind) ? save(req, reply, deps, null, kind) : reply.callNotFound();
  });
  app.get<{ Params: { id: string } }>("/channels/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const ch = id ? deps.stores.channels.getPublic(id) : undefined;
    if (!id || !ch) return reply.callNotFound();
    const values = channelValues(ch.kind, storedConfig(deps, id) ?? {});
    return renderForm(reply, deps, { channel: ch, kind: ch.kind, values, enabled: ch.enabled, errors: {} });
  });
  app.post<{ Params: { id: string } }>("/channels/:id", (req, reply) => {
    const id = parseId(req.params.id);
    const ch = id ? deps.stores.channels.getPublic(id) : undefined;
    return ch ? save(req, reply, deps, ch, ch.kind) : reply.callNotFound();
  });
  app.post<{ Params: { id: string } }>("/channels/:id/delete", async (req, reply) => remove(req, reply, deps));
  app.post<{ Params: { id: string } }>("/channels/:id/test", (req, reply) => sendTest(req, reply, deps));
}
