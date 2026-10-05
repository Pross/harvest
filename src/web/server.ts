import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import view from "@fastify/view";
import { Eta } from "eta";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrustProxy } from "../config.js";
import { redactUrl } from "../logger.js";
import { cookieSecure, registerAuth } from "./auth.js";
import { registerGuards } from "./csrf.js";
import type { AppDeps } from "./deps.js";
import { render } from "./helpers.js";
import { registerDashboardRoutes } from "./routes-dashboard.js";
import { registerSetup, ensureAdmin } from "./setup.js";
import { registerSse, type SseOptions } from "./sse.js";
import { registerStreamHub } from "./stream-hub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** src/web -> repo root (dev, tsx, vitest) and dist/web -> /app (prod; views/ and public/ are copied next to dist/). */
const ROOT = path.resolve(here, "..", "..");
export const VIEWS_DIR = path.join(ROOT, "views");
export const PUBLIC_DIR = path.join(ROOT, "public");

/** Feature modules (W2/W3) plug in here; they run after auth, CSRF and views are in place. */
export type RouteRegistrar = (app: FastifyInstance, deps: AppDeps) => Promise<void> | void;
export type ServerOptions = SseOptions;

const STATUS_TEXT: Record<number, string> = {
  400: "Bad request", 401: "Authentication required", 403: "Forbidden", 404: "Page not found",
  405: "Method not allowed", 413: "Request too large", 415: "Unsupported media type", 429: "Too many requests",
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

function wantsJson(accept: string | undefined): boolean {
  return !!accept && accept.includes("application/json") && !accept.includes("text/html");
}

function registerErrorPages(app: FastifyInstance, deps: AppDeps): void {
  app.setErrorHandler(async (err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) deps.logger.error({ err, method: req.method, url: redactUrl(req.url) }, "Unhandled request error");
    const message = STATUS_TEXT[status] ?? "Something went wrong";
    if (wantsJson(req.headers.accept)) return reply.code(status).send({ error: message });
    return render(reply, deps, "partials/error.eta", { title: message, status, message }, status);
  });
  app.setNotFoundHandler(async (req, reply) => {
    if (wantsJson(req.headers.accept)) return reply.code(404).send({ error: STATUS_TEXT[404] });
    return render(reply, deps, "partials/error.eta", { title: STATUS_TEXT[404], status: 404, message: STATUS_TEXT[404] }, 404);
  });
}

async function registerPlugins(app: FastifyInstance, deps: AppDeps): Promise<void> {
  await app.register(formbody);
  await app.register(cookie);
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/static/", maxAge: deps.config.NODE_ENV === "production" ? "1h" : 0 });
  const eta = new Eta({ views: VIEWS_DIR, cache: deps.config.NODE_ENV === "production" });
  await app.register(view, { engine: { eta }, root: VIEWS_DIR });
  app.addHook("onSend", async (req, reply) => {
    // Authenticated pages hold settings and job data: keep them out of shared and back/forward caches.
    if (req.auth?.authenticated && String(reply.getHeader("content-type") ?? "").startsWith("text/html")) reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff").header("x-frame-options", "DENY")
      .header("referrer-policy", "same-origin").header("content-security-policy", CSP);
  });
}

/**
 * TRUST_PROXY to Fastify's option: false | true (unsafe, trusts any X-Forwarded-For) | trusted proxy IPs/CIDRs.
 * A hop count becomes a function: Fastify 5 treats a bare number as "trust nobody", so the count is implemented here
 * (hop 0 is the socket peer; with N=1 the client address is the last X-Forwarded-For entry, which the proxy appended).
 */
export function trustProxyOption(v: TrustProxy): boolean | string[] | ((addr: string, hop: number) => boolean) {
  return typeof v === "number" ? (_addr, hop) => hop < v : v;
}

/** Unauthenticated liveness plus a database round trip, so a broken or closed DB turns the container unhealthy. */
function registerHealth(app: FastifyInstance, deps: AppDeps): void {
  app.get("/healthz", async (_req, reply) => {
    try {
      deps.db.prepare("select 1").get();
      return { ok: true };
    } catch (err) {
      deps.logger.error({ err }, "Health check: database unavailable");
      return reply.code(503).send({ ok: false });
    }
  });
}

export async function buildServer(deps: AppDeps, extraRoutes: RouteRegistrar[] = [], opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: trustProxyOption(deps.config.TRUST_PROXY),
  });
  app.decorate("cookieSecureFor", (req) => cookieSecure(req, deps));
  registerStreamHub(app);
  await registerPlugins(app, deps);
  registerHealth(app, deps);
  registerGuards(app, deps);
  const sessions = await registerAuth(app, deps, opts);
  registerSetup(app, deps, await ensureAdmin(deps));
  registerSse(app, deps, sessions, opts);
  registerDashboardRoutes(app, deps);
  for (const register of extraRoutes) await register(app, deps);
  registerErrorPages(app, deps);
  return app;
}
