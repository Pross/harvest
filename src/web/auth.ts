import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashPassword, randomToken, verifyPassword } from "../crypto.js";
import { isHookPath } from "./csrf.js";
import type { AppDeps } from "./deps.js";
import { ANONYMOUS, SESSION_COOKIE, isPublicPath, redirectTo, render, requireAuth, type AuthContext } from "./helpers.js";
import { SESSION_TTL_MS, SessionStore, findUser, type Session } from "./sessions.js";

export const LOGIN_LIMIT = 5;
export const LOGIN_USER_LIMIT = 10;
export const LOGIN_GLOBAL_LIMIT = 30;
export const LOGIN_WINDOW_MS = 60_000;
const GENERIC_ERROR = "Invalid username or password.";

/** In-memory sliding-window throttle: at most `limit` attempts per `windowMs` per key. */
export class LoginThrottle {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now, private readonly limit = LOGIN_LIMIT, private readonly windowMs = LOGIN_WINDOW_MS) {}

  private recent(key: string, t: number): number[] {
    return (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
  }

  /** True when one more attempt for the key fits in the window. Records nothing. */
  has(key: string): boolean {
    return this.recent(key, this.now()).length < this.limit;
  }

  record(key: string): void {
    const t = this.now();
    this.hits.set(key, [...this.recent(key, t), t]);
    if (this.hits.size > 1000) this.prune(t);
  }

  /** Records an attempt; false when the key is over the limit (the attempt is not counted then). */
  allow(key: string): boolean {
    const ok = this.has(key);
    if (ok) this.record(key);
    return ok;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if ((v[v.length - 1] ?? 0) <= t - this.windowMs) this.hits.delete(k);
  }
}

export type AttemptScope = "login" | "password";

/**
 * Per-IP, per-username and (login only) global caps on password guesses. An attempt is recorded in every bucket
 * only when all of them have room, so the maps stay bounded by the global cap. Behind a proxy `ip` is only
 * trustworthy when TRUST_PROXY names the proxy (see config.ts).
 */
export class AttemptLimiter {
  private readonly perIp: LoginThrottle;
  private readonly perUser: LoginThrottle;
  private readonly global: LoginThrottle;

  constructor(now: () => number = Date.now) {
    this.perIp = new LoginThrottle(now, LOGIN_LIMIT);
    this.perUser = new LoginThrottle(now, LOGIN_USER_LIMIT);
    this.global = new LoginThrottle(now, LOGIN_GLOBAL_LIMIT);
  }

  allow(scope: AttemptScope, ip: string, username: string): boolean {
    const keys: [LoginThrottle, string][] = [[this.perIp, `${scope}:${ip}`], [this.perUser, `${scope}:${username.toLowerCase().slice(0, 200)}`]];
    if (scope === "login") keys.push([this.global, "all"]);
    if (!keys.every(([t, k]) => t.has(k))) return false;
    for (const [t, k] of keys) t.record(k);
    return true;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    attempts: AttemptLimiter;
  }
}

export function cookieSecure(req: FastifyRequest, deps: AppDeps): boolean {
  return deps.config.COOKIE_SECURE || (deps.config.TRUST_PROXY !== false && req.protocol === "https");
}

function setSessionCookie(reply: FastifyReply, req: FastifyRequest, deps: AppDeps, s: Session): void {
  reply.setCookie(SESSION_COOKIE, s.id, {
    path: "/", httpOnly: true, sameSite: "lax", secure: cookieSecure(req, deps), maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

function toContext(s: Session): AuthContext {
  return { authenticated: true, user: { id: s.userId, username: s.username }, csrfToken: s.csrfToken, sessionId: s.id };
}

export type AuthOptions = { now?: () => number };

/** Resolves req.auth for every request, then enforces authentication on non-public paths. */
function registerAuthHook(app: FastifyInstance, deps: AppDeps, sessions: SessionStore): void {
  const noneToken = randomToken();
  app.decorateRequest("auth", null as unknown as AuthContext);
  app.addHook("onRequest", async (req, reply) => {
    req.auth = ANONYMOUS;
    if (deps.config.AUTH_MODE === "none") {
      req.auth = { authenticated: true, user: null, csrfToken: noneToken, sessionId: null };
      return undefined;
    }
    const sid = req.cookies?.[SESSION_COOKIE];
    const session = sid ? sessions.get(sid) : undefined;
    if (session) {
      req.auth = toContext(session);
      if (session.refreshed) setSessionCookie(reply, req, deps, session);
    }
    // Webhooks (/hooks/*) bring their own bearer token; see csrf.ts for the single exemption point.
    if (!isPublicPath(req.url) && !isHookPath(req.method, req.url)) return requireAuth(req, reply);
    return undefined;
  });
}

const LoginBody = z.object({ username: z.string().max(200), password: z.string().max(1000) });
let dummyHash: Promise<string> | undefined;

/** Computed at startup (registerAuth), not on the first failed login. */
const getDummyHash = (): Promise<string> => (dummyHash ??= hashPassword(randomToken(8)));

/** Verifies against a dummy hash when the user is unknown so timing does not reveal existence. */
async function checkCredentials(deps: AppDeps, dummy: string, username: string, password: string): Promise<{ id: number } | null> {
  const user = findUser(deps.db, username);
  const ok = await verifyPassword(password, user?.passwordHash ?? dummy);
  return user && ok ? { id: user.id } : null;
}

function registerLogin(app: FastifyInstance, deps: AppDeps, sessions: SessionStore, dummy: string): void {
  app.get("/login", async (req, reply) => {
    if (deps.config.AUTH_MODE === "none" || req.auth.authenticated) return redirectTo(reply, "/");
    return render(reply, deps, "login.eta", { title: "Sign in", error: null, username: "" });
  });
  app.post("/login", async (req, reply) => {
    if (deps.config.AUTH_MODE === "none") return redirectTo(reply, "/");
    const parsed = LoginBody.safeParse(req.body ?? {});
    const username = parsed.success ? parsed.data.username : "";
    const fail = (status: number, error: string) => render(reply, deps, "login.eta", { title: "Sign in", error, username }, status);
    if (!app.attempts.allow("login", req.ip, username)) return fail(429, "Too many attempts. Wait a minute and try again.");
    const user = parsed.success ? await checkCredentials(deps, dummy, username, parsed.data.password) : null;
    if (!user) return fail(401, GENERIC_ERROR);
    if (req.auth.sessionId) sessions.delete(req.auth.sessionId);
    setSessionCookie(reply, req, deps, sessions.create(user.id));
    return redirectTo(reply, "/");
  });
}

export async function registerAuth(app: FastifyInstance, deps: AppDeps, opts: AuthOptions = {}): Promise<SessionStore> {
  const sessions = new SessionStore(deps.db, opts.now);
  app.decorate("attempts", new AttemptLimiter(opts.now));
  registerAuthHook(app, deps, sessions);
  registerLogin(app, deps, sessions, await getDummyHash());
  app.post("/logout", async (req, reply) => {
    if (req.auth.sessionId) {
      sessions.delete(req.auth.sessionId);
      app.streams.closeSession(req.auth.sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return redirectTo(reply, deps.config.AUTH_MODE === "none" ? "/" : "/login");
  });
  return sessions;
}
