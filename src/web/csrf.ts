import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { constantTimeEqual } from "../crypto.js";
import type { AppDeps } from "./deps.js";
import { isPublicPath, pathOf, render } from "./helpers.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Phase 2 webhooks (`POST /hooks/jobs/<digits>`, nothing else) authenticate with their own bearer token, so they are
 * exempt from session, CSRF and the Origin check. This is the ONLY place that exemption is declared.
 */
const HOOK_PATH = /^\/hooks\/jobs\/\d+$/;
export const isHookPath = (method: string, url: string): boolean => method === "POST" && HOOK_PATH.test(pathOf(url));

const hostOnly = (h: string): string => h.toLowerCase().replace(/:\d+$/, "");

/** Host header allowlist (ALLOWED_HOSTS, both auth modes). Entries may carry a port. Unset means allow all. */
export function hostAllowed(host: string | undefined, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!host) return false;
  const h = host.toLowerCase();
  return allowed.some((a) => a.toLowerCase() === h || a.toLowerCase() === hostOnly(h));
}

function hostOfUrl(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Same-host check on Origin, falling back to Referer. Neither header present means reject. */
export function originAllowed(req: FastifyRequest, deps: AppDeps): boolean {
  const raw = req.headers.origin ?? req.headers.referer;
  if (typeof raw !== "string" || raw === "" || raw === "null") return false;
  const from = hostOfUrl(raw);
  if (!from) return false;
  const accepted = [req.host.toLowerCase()];
  if (deps.config.PUBLIC_URL) accepted.push(hostOfUrl(deps.config.PUBLIC_URL) ?? "");
  return accepted.includes(from);
}

/** Constant-time check of the presented token (field `_csrf` or header `x-csrf-token`). */
export function csrfTokenOk(req: FastifyRequest): boolean {
  const expected = req.auth.csrfToken;
  const body = req.body as Record<string, unknown> | undefined | null;
  const field = body && typeof body === "object" ? body["_csrf"] : undefined;
  const header = req.headers["x-csrf-token"];
  const presented = typeof header === "string" ? header : typeof field === "string" ? field : "";
  return expected !== "" && presented !== "" && constantTimeEqual(presented, expected);
}

async function forbid(reply: FastifyReply, deps: AppDeps, code: number, message: string): Promise<FastifyReply> {
  const accepts = reply.request.headers.accept ?? "";
  if (accepts.includes("application/json") && !accepts.includes("text/html")) {
    return reply.code(code).send({ error: message });
  }
  return render(reply, deps, "partials/error.eta", { title: message, status: code, message }, code);
}

/** Host allowlist and Origin check as onRequest hooks, token check as preHandler. Register BEFORE auth. */
export function registerGuards(app: FastifyInstance, deps: AppDeps): void {
  app.addHook("onRequest", async (req, reply) => {
    if (pathOf(req.url) === "/healthz") return;
    if (!hostAllowed(req.host, deps.config.ALLOWED_HOSTS)) {
      return forbid(reply, deps, 421, "Unknown host");
    }
    if (SAFE_METHODS.has(req.method) || isHookPath(req.method, req.url)) return;
    if (!originAllowed(req, deps)) return forbid(reply, deps, 403, "Cross-site request blocked");
  });
  app.addHook("preHandler", async (req, reply) => {
    if (SAFE_METHODS.has(req.method) || isHookPath(req.method, req.url)) return;
    // Pre-session forms (/login, /setup) have no token yet; they rely on the Origin check above.
    if (isPublicPath(req.url)) return;
    if (!csrfTokenOk(req)) return forbid(reply, deps, 403, "Invalid or missing CSRF token");
  });
}
