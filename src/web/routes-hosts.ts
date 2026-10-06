import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import type { HostConfig } from "../domain.js";
import { HarvestError } from "../errors.js";
import { HostInUseError } from "../store/index.js";
import type { RemoteEntry, ScannedHostKey } from "../engine/types.js";
import type { HostPublic } from "../store/host-store.js";
import type { AppDeps } from "./deps.js";
import {
  NEW_HOST_VALUES, PROTOCOL_OPTIONS, bodyStrings, buildSecret, friendlyConnectionError, hostToValues, hostValues,
  parseHostForm, parseId, type FormErrors,
} from "./host-schemas.js";
import { UNDECRYPTABLE_MESSAGE, loadHostConfig, secretForUpdate, targetChanged } from "./host-config.js";
import { redirectTo, render, renderFragment } from "./helpers.js";

const isHtmx = (req: FastifyRequest): boolean => req.headers["hx-request"] === "true";
const lines = (s: string | null): string[] => (s ? s.split("\n").filter(Boolean) : []);
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

async function renderForm(reply: FastifyReply, deps: AppDeps, host: HostPublic | null, values: Record<string, string>, errors: FormErrors, status = 200) {
  const undecryptable = !!host && host.hasSecret && loadHostConfig(deps, host.id).undecryptable;
  const data = {
    title: host ? `Host ${host.name}` : "New host", nav: "hosts", host, values, errors, protocols: PROTOCOL_OPTIONS, undecryptable,
    undecryptableMessage: UNDECRYPTABLE_MESSAGE,
    action: host ? `/hosts/${host.id}` : "/hosts", jobCount: host ? deps.stores.jobs.list().filter((j) => j.hostId === host.id).length : 0,
  };
  return render(reply, deps, "host-form.eta", data, status);
}

function listPage(deps: AppDeps) {
  const jobs = deps.stores.jobs.list();
  const hosts = deps.stores.hosts.listPublic().map((h) => ({
    ...h, undecryptable: h.hasSecret && loadHostConfig(deps, h.id).undecryptable, jobCount: jobs.filter((j) => j.hostId === h.id).length,
    keyStatus: h.protocol !== "sftp" ? "n/a" : h.hostKeySha256 ? lines(h.hostKeySha256).join(", ") : "not pinned",
    pinned: h.protocol === "sftp" && !!h.hostKeySha256,
  }));
  return { title: "Hosts", nav: "hosts", hosts, anyUndecryptable: hosts.some((h) => h.undecryptable), undecryptableMessage: UNDECRYPTABLE_MESSAGE };
}

const nameTaken = (deps: AppDeps, name: string, exceptId: number | null): boolean =>
  deps.stores.hosts.listPublic().some((h) => h.id !== exceptId && h.name.toLowerCase() === name.toLowerCase());

/**
 * Config for a test from the posted values. Stored secrets are reused only for the same host/port/username and only when
 * they decrypt; otherwise (target changed, APP_SECRET changed) the secret must be posted again. Never rendered.
 */
export function configFromForm(deps: AppDeps, body: unknown): { cfg: HostConfig } | { error: string } {
  const cur = parseId(bodyStrings(body)["id"] ?? "");
  const pub = cur ? deps.stores.hosts.getPublic(cur) : undefined;
  const loaded = pub ? loadHostConfig(deps, pub.id) : null;
  const parsed = parseHostForm(body);
  if (!parsed.ok) return { error: Object.values(parsed.errors)[0] ?? "Check the form" };
  const d = parsed.data;
  const stored = loaded && !loaded.undecryptable && !targetChanged(loaded.cfg, d) ? loaded.cfg : null;
  if (pub && !stored && !(d.authKind === "key" ? d.privateKey : d.password)) {
    return { error: loaded?.undecryptable ? UNDECRYPTABLE_MESSAGE : "Enter the password or key again: the stored one is not sent to a different host, port or username." };
  }
  const s = buildSecret(d, stored);
  if ("errors" in s) return { error: Object.values(s.errors)[0] ?? "Check the form" };
  return { cfg: {
    id: pub?.id ?? 0, name: d.name, protocol: d.protocol, host: d.host, port: d.port, username: d.username, authKind: d.authKind,
    secret: s.secret ?? stored?.secret ?? {}, tlsAcceptSelfSigned: d.tlsAcceptSelfSigned, hostKeys: null, maxConnections: d.maxConnections,
  } };
}

function listingOf(entries: RemoteEntry[]) {
  const sorted = [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
  return { listing: sorted.slice(0, 50).map((e) => ({ name: path.posix.basename(e.path), isDir: e.isDir })), more: Math.max(0, sorted.length - 50) };
}

function keyInfo(keys: ScannedHostKey[], protocol: string, pinned: string | null) {
  const fingerprints = keys.map((k) => k.sha256);
  const none = protocol !== "sftp" || keys.length === 0;
  const keyState = none ? "none" : !pinned ? "new" : sameSet(fingerprints, lines(pinned)) ? "same" : "changed";
  return { keys: keys.map((k) => ({ type: k.type, sha256: k.sha256 })), fingerprints, keyState, pinnedLines: lines(pinned) };
}

/** Scan and list with the pin ignored, so a changed key is reported (and compared here) instead of refused by the engine. */
async function runTest(deps: AppDeps, cfg: HostConfig, pinned: string | null) {
  try {
    const res = await deps.engine.testConnection({ ...cfg, hostKeys: null });
    return { ok: true, hostId: cfg.id, ...listingOf(res.rootListing), ...keyInfo(res.hostKeys ?? [], cfg.protocol, pinned) };
  } catch (err) {
    if (!(err instanceof HarvestError)) deps.logger.warn({ errorName: err instanceof Error ? err.name : "unknown" }, "Connection test failed unexpectedly");
    return { ok: false, hostId: cfg.id, ...friendlyConnectionError(err, cfg.secret) };
  }
}

async function sendResult(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, result: Record<string, unknown>) {
  if (isHtmx(req)) return renderFragment(reply, deps, "partials/host-test-result.eta", { result });
  return render(reply, deps, "partials/host-test-page.eta", { title: "Connection test", nav: "hosts", result });
}

function registerTest(app: FastifyInstance, deps: AppDeps): void {
  app.post("/hosts/test", async (req, reply) => {
    const built = configFromForm(deps, req.body);
    if ("error" in built) return sendResult(req, reply, deps, { ok: false, kind: "form", message: `Fix the form first: ${built.error}` });
    const stored = built.cfg.id ? deps.stores.hosts.getPublic(built.cfg.id) : undefined;
    const sameAddr = stored && stored.host === built.cfg.host && stored.port === built.cfg.port;
    return sendResult(req, reply, deps, await runTest(deps, built.cfg, sameAddr ? stored.hostKeySha256 : null));
  });
  app.post<{ Params: { id: string } }>("/hosts/:id/test", async (req, reply) => {
    const id = parseId(req.params.id);
    const pub = id ? deps.stores.hosts.getPublic(id) : undefined;
    if (!id || !pub) return reply.callNotFound();
    const loaded = loadHostConfig(deps, id);
    if (loaded.undecryptable) return sendResult(req, reply, deps, { ok: false, hostId: id, kind: "secret", message: UNDECRYPTABLE_MESSAGE });
    return sendResult(req, reply, deps, await runTest(deps, loaded.cfg, pub.hostKeySha256));
  });
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x !== "");

async function pinKeys(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, deps: AppDeps) {
  const id = parseId(req.params.id);
  const pub = id ? deps.stores.hosts.getPublic(id) : undefined;
  if (!id || !pub) return reply.callNotFound();
  const back = `/hosts/${id}`;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const confirmed = list(body["fingerprint"]);
  if (pub.protocol !== "sftp" || confirmed.length === 0) return redirectTo(reply, back, { kind: "error", message: "Nothing to pin: test the connection first." });
  const loaded = loadHostConfig(deps, id);
  if (loaded.undecryptable) return redirectTo(reply, back, { kind: "error", message: UNDECRYPTABLE_MESSAGE });
  const cfg = loaded.cfg;
  let scanned: ScannedHostKey[];
  try {
    scanned = (await deps.engine.testConnection({ ...cfg, hostKeys: null })).hostKeys ?? [];
  } catch (err) {
    return redirectTo(reply, back, { kind: "error", message: friendlyConnectionError(err, cfg.secret).message });
  }
  if (!sameSet(scanned.map((k) => k.sha256), confirmed)) {
    return redirectTo(reply, back, { kind: "error", message: "The server's keys changed since you looked at them. Nothing was pinned: test again and re-check the fingerprints." });
  }
  if (pub.hostKeySha256 && !sameSet(lines(pub.hostKeySha256), confirmed) && body["confirm_replace"] !== "1") {
    return redirectTo(reply, back, { kind: "error", message: "A different key is already pinned. Tick the confirmation to replace it." });
  }
  deps.stores.hosts.setHostKeys(id, scanned.map((k) => k.line).join("\n"), scanned.map((k) => k.sha256).join("\n"));
  return redirectTo(reply, back, { kind: "ok", message: "Host key pinned." });
}

async function createHost(req: FastifyRequest, reply: FastifyReply, deps: AppDeps) {
  const parsed = parseHostForm(req.body);
  const values = hostValues(req.body);
  if (!parsed.ok) return renderForm(reply, deps, null, values, parsed.errors, 400);
  const errors: FormErrors = nameTaken(deps, parsed.data.name, null) ? { name: "A host with this name already exists" } : {};
  const s = buildSecret(parsed.data, null);
  if ("errors" in s) Object.assign(errors, s.errors);
  if (Object.keys(errors).length > 0 || "errors" in s) return renderForm(reply, deps, null, values, errors, 400);
  const d = parsed.data;
  const id = deps.stores.hosts.create({ name: d.name, protocol: d.protocol, host: d.host, port: d.port, username: d.username,
    authKind: d.authKind, ...(s.secret ? { secret: s.secret } : {}), tlsAcceptSelfSigned: d.tlsAcceptSelfSigned, maxConnections: d.maxConnections });
  const hint = d.protocol === "sftp" ? " Test the connection to pin its host key." : "";
  return redirectTo(reply, `/hosts/${id}`, { kind: "ok", message: `Host saved.${hint}` });
}

async function updateHost(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, deps: AppDeps) {
  const id = parseId(req.params.id);
  const pub = id ? deps.stores.hosts.getPublic(id) : undefined;
  if (!id || !pub) return reply.callNotFound();
  const parsed = parseHostForm(req.body);
  const values = hostValues(req.body);
  if (!parsed.ok) return renderForm(reply, deps, pub, values, parsed.errors, 400);
  const d = parsed.data;
  const errors: FormErrors = nameTaken(deps, d.name, id) ? { name: "A host with this name already exists" } : {};
  const s = secretForUpdate(d, loadHostConfig(deps, id));
  if ("errors" in s) Object.assign(errors, s.errors);
  if (Object.keys(errors).length > 0 || "errors" in s) return renderForm(reply, deps, pub, values, errors, 400);
  deps.stores.hosts.update(id, { name: d.name, protocol: d.protocol, host: d.host, port: d.port, username: d.username, authKind: d.authKind,
    ...(s.secret ? { secret: s.secret } : {}), tlsAcceptSelfSigned: d.tlsAcceptSelfSigned, maxConnections: d.maxConnections });
  const moved = pub.hostKeys !== null && (pub.host !== d.host || pub.port !== d.port || pub.protocol !== d.protocol);
  if (moved) deps.stores.hosts.setHostKeys(id, null, null);
  const note = moved ? " The pinned host key was cleared because the address changed: test the connection to pin it again." : "";
  return redirectTo(reply, "/hosts", { kind: "ok", message: `Host saved.${note}` });
}

function deleteHost(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply, deps: AppDeps) {
  const id = parseId(req.params.id);
  const pub = id ? deps.stores.hosts.getPublic(id) : undefined;
  if (!id || !pub) return reply.callNotFound();
  try {
    deps.stores.hosts.delete(id);
  } catch (err) {
    if (!(err instanceof HostInUseError)) throw err;
    const n = err.jobNames.length;
    return redirectTo(reply, "/hosts", { kind: "error", message: `Host "${pub.name}" is used by ${n} job${n === 1 ? "" : "s"} (${err.jobNames.join(", ")}). Delete those jobs first.` });
  }
  return redirectTo(reply, "/hosts", { kind: "ok", message: `Host "${pub.name}" deleted.` });
}

export function registerHostRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/hosts", async (_req, reply) => render(reply, deps, "hosts.eta", listPage(deps)));
  app.get("/hosts/new", async (_req, reply) => renderForm(reply, deps, null, NEW_HOST_VALUES, {}));
  app.post("/hosts", (req, reply) => createHost(req, reply, deps));
  registerTest(app, deps);
  app.get<{ Params: { id: string } }>("/hosts/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const pub = id ? deps.stores.hosts.getPublic(id) : undefined;
    return pub ? renderForm(reply, deps, pub, hostToValues(pub), {}) : reply.callNotFound();
  });
  app.post<{ Params: { id: string } }>("/hosts/:id", (req, reply) => updateHost(req, reply, deps));
  app.post<{ Params: { id: string } }>("/hosts/:id/delete", async (req, reply) => deleteHost(req, reply, deps));
  app.post<{ Params: { id: string } }>("/hosts/:id/pin", (req, reply) => pinKeys(req, reply, deps));
}
