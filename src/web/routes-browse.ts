import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import path from "node:path";
import type { AppDeps } from "./deps.js";
import { loadHostConfig, UNDECRYPTABLE_MESSAGE } from "./host-config.js";
import { bodyStrings, friendlyConnectionError, parseId } from "./host-schemas.js";
import { formatBytes } from "./format.js";
import { render, renderFragment } from "./helpers.js";
import { listLocal } from "./local-browse.js";

type Link = { name: string; href: string };
/** One model for both browsers, rendered by partials/browse-listing.eta. */
type Listing = {
  field: "local_path" | "remote_path"; base: string; error: string | null; rootHref: string;
  crumbs: Link[]; entries: Link[]; files: { name: string; size: string }[]; pick: string | null; note: string; more: string;
};

const enc = encodeURIComponent;
const pickHref = (field: string, value: string): string => `/browse/pick?field=${field}&value=${enc(value)}`;

async function send(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, model: Listing) {
  if (req.headers["hx-request"] === "true") return renderFragment(reply, deps, "partials/browse-listing.eta", model);
  return render(reply, deps, "partials/browse-page.eta", { title: "Browse folders", nav: "jobs", ...model });
}

async function localModel(deps: AppDeps, raw: string | undefined): Promise<Listing> {
  const base = "/browse/local";
  const out: Listing = { field: "local_path", base, error: null, rootHref: base, crumbs: [], entries: [], files: [], pick: null, note: "", more: "" };
  const l = await listLocal(raw, deps.config);
  if (!l.ok) return { ...out, error: l.error };
  if (l.kind === "roots") {
    return { ...out, entries: l.roots.map((r) => ({ name: `${r.path} (free ${r.free})`, href: `${base}?path=${enc(r.path)}` })),
      note: l.roots.length === 0 ? "No browse roots are available." : "Choose a root folder." };
  }
  return {
    ...out, note: `Free space: ${l.free}`, pick: pickHref("local_path", l.path),
    crumbs: l.crumbs.map((c) => ({ name: c.name, href: `${base}?path=${enc(c.path)}` })),
    ...capEntries(l.dirs.map((d) => ({ name: d.name, href: `${base}?path=${enc(d.path)}` })), []),
  };
}

const remoteDir = (raw: string | undefined): string => {
  const p = path.posix.join("/", (raw ?? "").trim() || "/");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
};

function crumbsOf(dir: string, href: (p: string) => string): Link[] {
  const crumbs: Link[] = [{ name: "/", href: href("/") }];
  let cur = "";
  for (const seg of dir.split("/").filter(Boolean)) {
    cur += `/${seg}`;
    crumbs.push({ name: seg, href: href(cur) });
  }
  return crumbs;
}

export const MAX_BROWSE_ENTRIES = 500;

/** Folders first, then files, at most MAX_BROWSE_ENTRIES in total; `more` says how many were left out. */
function capEntries(entries: Link[], files: { name: string; size: string }[]): Pick<Listing, "entries" | "files" | "more"> {
  const shownDirs = entries.slice(0, MAX_BROWSE_ENTRIES);
  const shownFiles = files.slice(0, MAX_BROWSE_ENTRIES - shownDirs.length);
  const hidden = entries.length + files.length - shownDirs.length - shownFiles.length;
  return { entries: shownDirs, files: shownFiles, more: hidden > 0 ? `and ${hidden} more not shown` : "" };
}

async function remoteModel(deps: AppDeps, hostId: number | null, raw: string | undefined): Promise<Listing> {
  const base = "/browse/remote";
  const out: Listing = { field: "remote_path", base, error: null, rootHref: `${base}?host=${hostId ?? ""}&path=%2F`, crumbs: [], entries: [], files: [], pick: null, note: "", more: "" };
  if (!hostId || !deps.stores.hosts.getPublic(hostId)) return { ...out, error: "Choose a host first, then browse its folders." };
  const dir = remoteDir(raw);
  const href = (p: string): string => `${base}?host=${hostId}&path=${enc(p)}`;
  const loaded = loadHostConfig(deps, hostId);
  if (loaded.undecryptable) return { ...out, crumbs: crumbsOf(dir, href), error: UNDECRYPTABLE_MESSAGE };
  const cfg = loaded.cfg;
  let session: Awaited<ReturnType<AppDeps["engine"]["open"]>> | undefined;
  try {
    session = await deps.engine.open(cfg);
    const items = (await session.list(dir, { recurse: false })).map((e) => ({ name: path.posix.basename(e.path), e }));
    const sort = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
    return {
      ...out, crumbs: crumbsOf(dir, href), pick: pickHref("remote_path", dir),
      ...capEntries(
        items.filter((i) => i.e.isDir).sort(sort).map((i) => ({ name: i.name, href: href(path.posix.join(dir, i.name)) })),
        items.filter((i) => !i.e.isDir).sort(sort).map((i) => ({ name: i.name, size: formatBytes(i.e.size) })),
      ),
    };
  } catch (err) {
    return { ...out, crumbs: crumbsOf(dir, href), error: friendlyConnectionError(err, cfg.secret).message };
  } finally {
    await session?.close().catch((err: unknown) => deps.logger.debug({ errorName: err instanceof Error ? err.name : "unknown" }, "Closing browse session failed"));
  }
}

/** Read-only folder browsers (htmx fragments) and the "use this folder" input swap. */
export function registerBrowseRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/browse/local", async (req, reply) => {
    const q = bodyStrings(req.query);
    return send(req, reply, deps, await localModel(deps, q["path"] ?? q["local_path"]));
  });
  app.get("/browse/remote", async (req, reply) => {
    const q = bodyStrings(req.query);
    return send(req, reply, deps, await remoteModel(deps, parseId(q["host"] ?? q["host_id"] ?? ""), q["path"] ?? q["remote_path"]));
  });
  app.get("/browse/pick", async (req, reply) => {
    const q = bodyStrings(req.query);
    const field = q["field"];
    if (field !== "local_path" && field !== "remote_path") return reply.callNotFound();
    return renderFragment(reply, deps, "partials/browse-input.eta", { field, value: (q["value"] ?? "").slice(0, 4096), swapOob: true });
  });
}
