import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import "@fastify/cookie";
import "@fastify/view";
import type { AppDeps } from "./deps.js";
import { escapeHtml } from "./format.js";

export const SESSION_COOKIE = "harvest_sid";
export const FLASH_COOKIE = "harvest_flash";

/** Set on every request by the auth hook (anonymous on public paths). */
export type AuthContext = {
  authenticated: boolean;
  user: { id: number; username: string } | null;
  /** Session token in builtin mode, per-process token in none mode, "" when anonymous. */
  csrfToken: string;
  sessionId: string | null;
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyInstance {
    /** Whether cookies set for this request get the Secure flag (COOKIE_SECURE, or https behind a trusted proxy). */
    cookieSecureFor: (req: FastifyRequest) => boolean;
  }
}

export const ANONYMOUS: AuthContext = { authenticated: false, user: null, csrfToken: "", sessionId: null };

export const pathOf = (url: string): string => url.split(/[?#]/)[0] ?? "";

/** Paths served without a session: login, setup, health, metrics (only routed when METRICS_ENABLED) and static assets. The only place this list lives. */
export function isPublicPath(url: string): boolean {
  const p = pathOf(url);
  return p === "/healthz" || p === "/metrics" || p === "/login" || p === "/setup" || p.startsWith("/static/");
}

/** Hidden CSRF input for forms. Emit with `<%~ csrfField(it.csrfToken) %>` or via `it.csrfField`. */
export function csrfField(csrfToken: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`;
}

export type FlashKind = "ok" | "error" | "info";
export type Flash = { kind: FlashKind; message: string };

/** Flash message: short-lived (60 s) HttpOnly cookie `harvest_flash` = "<kind>:<urlencoded message>"; read and cleared by render(). */
export function setFlash(reply: FastifyReply, kind: FlashKind, message: string): void {
  reply.setCookie(FLASH_COOKIE, `${kind}:${encodeURIComponent(safeSlice(message, 300))}`, {
    path: "/", httpOnly: true, sameSite: "lax", maxAge: 60, secure: reply.server.cookieSecureFor(reply.request),
  });
}

/** Replaces lone surrogates (encodeURIComponent throws on them) and never ends on half of a surrogate pair after slicing. */
export function wellFormed(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** slice(0, n) that does not cut a surrogate pair in half. */
export function safeSlice(s: string, n: number): string {
  const cut = s.slice(0, n);
  return wellFormed(cut.length > 0 && /[\ud800-\udbff]$/.test(cut) && s.length > n ? cut.slice(0, -1) : cut);
}

function readFlash(req: FastifyRequest, reply: FastifyReply): Flash | null {
  const raw = req.cookies?.[FLASH_COOKIE];
  if (!raw) return null;
  reply.clearCookie(FLASH_COOKIE, { path: "/" });
  const i = raw.indexOf(":");
  const kind = raw.slice(0, i);
  if (i < 0 || !["ok", "error", "info"].includes(kind)) return null;
  try {
    return { kind: kind as FlashKind, message: decodeURIComponent(raw.slice(i + 1)) };
  } catch {
    return null;
  }
}

/** Redirect after POST (303). Optionally sets a flash message first. */
export function redirectTo(reply: FastifyReply, url: string, flash?: Flash): FastifyReply {
  if (flash) setFlash(reply, flash.kind, flash.message);
  return reply.redirect(url, 303);
}

/**
 * Runs an "after save" hook (scheduler reload, settings apply). The DB write has already committed, so a throwing hook
 * must not turn the response into a 500: it is logged and the caller flashes a "saved but not applied" warning.
 */
export function runHook(deps: AppDeps, hook: () => void, what: string): boolean {
  try {
    hook();
    return true;
  } catch (err) {
    deps.logger.error({ err, hook: what }, "Change saved but the follow-up step failed");
    return false;
  }
}

/** Flash for a saved change: ok when applied, otherwise a warning that it is saved but not applied yet. */
export function savedFlash(applied: boolean, message: string): Flash {
  return applied ? { kind: "ok", message } : { kind: "error", message: `${message.replace(/\.$/, "")}, but not applied: see the logs. Restart Harvest to apply it.` };
}

export type PageData = Record<string, unknown> & { title?: string; nav?: string | null };

/** The keys every template can rely on, merged under route-supplied data. */
export function pageContext(req: FastifyRequest, reply: FastifyReply, deps: AppDeps, data: PageData = {}): Record<string, unknown> {
  const auth = req.auth ?? ANONYMOUS;
  return {
    appName: "Harvest",
    title: "Harvest",
    nav: null,
    csrfToken: auth.csrfToken,
    csrfField: csrfField(auth.csrfToken),
    hxHeaders: JSON.stringify({ "x-csrf-token": auth.csrfToken }),
    authMode: deps.config.AUTH_MODE,
    secretBanner: deps.appSecretSource === "generated",
    hostsUnrestricted: deps.config.AUTH_MODE === "none" && !deps.config.ALLOWED_HOSTS?.length,
    user: auth.user,
    flash: readFlash(req, reply),
    ...data,
  };
}

/** Render `views/<template>` inside layout.eta and send it as HTML. The one way pages are sent. */
export async function render(
  reply: FastifyReply,
  deps: AppDeps,
  template: string,
  data: PageData = {},
  status = 200,
): Promise<FastifyReply> {
  const ctx = pageContext(reply.request, reply, deps, data);
  const body = await reply.server.view(template, ctx);
  const html = await reply.server.view("layout.eta", { ...ctx, body });
  return reply.code(status).type("text/html; charset=utf-8").send(html);
}

/** Render a partial (no layout) and send it: htmx fragment responses. */
export async function renderFragment(
  reply: FastifyReply,
  deps: AppDeps,
  template: string,
  data: PageData = {},
): Promise<FastifyReply> {
  const ctx = pageContext(reply.request, reply, deps, data);
  const html = await reply.server.view(template, ctx);
  return reply.type("text/html; charset=utf-8").send(html);
}

/** String variant used outside a reply (SSE). */
export function renderToString(app: FastifyInstance, template: string, data: Record<string, unknown>): Promise<string> {
  return app.view(template, data);
}

const isHtmx = (req: FastifyRequest): boolean => req.headers["hx-request"] === "true";

/** preHandler/onRequest hook: 303 to /login (GET) or 401 (others; htmx gets HX-Redirect). Passes when authenticated. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  if (req.auth?.authenticated) return undefined;
  if (isHtmx(req)) return reply.code(401).header("HX-Redirect", "/login").send("");
  if (req.method === "GET" || req.method === "HEAD") return reply.redirect("/login", 303);
  return reply.code(401).type("text/plain").send("Authentication required");
}
