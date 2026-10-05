import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TriggerResult } from "../run/manager-types.js";
import type { ApiToken } from "../store/index.js";
import type { AppDeps } from "./deps.js";

/** Requests allowed per token per window (in memory, per process). */
export const HOOK_RATE_LIMIT = 6;
export const HOOK_RATE_WINDOW_MS = 60_000;

/** Sliding-window limiter keyed by token id. */
export class TokenRateLimiter {
  private readonly hits = new Map<number, number[]>();
  constructor(private readonly max = HOOK_RATE_LIMIT, private readonly windowMs = HOOK_RATE_WINDOW_MS) {}

  /** Returns 0 when allowed (and records the hit), otherwise the seconds until a slot frees. */
  check(key: number, now: number = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 1000) this.sweep(now);
    return 0;
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}

/** HTTP status and body for each manager answer. */
export function mapTrigger(r: TriggerResult): { code: number; body: Record<string, unknown> } {
  switch (r.status) {
    case "started":
    case "queued":
      return { code: 202, body: { status: r.status, runId: r.runId } };
    case "rerun_pending":
      return { code: 202, body: { status: r.status } };
    case "skipped_locked":
      return { code: 409, body: { status: r.status, runId: r.runId } };
    case "disabled":
      return { code: 409, body: { status: "disabled" } };
  }
}

type Presented = { token: string; viaQuery: boolean };

/** Bearer header wins; `?token=` is accepted because torrent clients make headers awkward. */
function presentedToken(req: FastifyRequest): Presented | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  if (m?.[1]) return { token: m[1], viaQuery: false };
  const q = (req.query as Record<string, unknown> | undefined)?.["token"];
  return typeof q === "string" && q !== "" ? { token: q, viaQuery: true } : null;
}

export function registerHookRoutes(app: FastifyInstance, deps: AppDeps): void {
  const limiter = new TokenRateLimiter();
  const warned = new Set<number>();
  const unauthorized = (reply: FastifyReply) => reply.code(401).header("cache-control", "no-store").send({ error: "Invalid token" });

  // Auth, CSRF and Origin do not apply here (csrf.ts#isHookPath); the bearer token is the only credential.
  app.post<{ Params: { id: string } }>("/hooks/jobs/:id", async (req, reply) => {
    const presented = presentedToken(req);
    const token: ApiToken | undefined = presented ? deps.stores.tokens.verify(presented.token) : undefined;
    const jobId = /^[1-9]\d{0,9}$/.test(req.params.id) ? Number(req.params.id) : -1;
    // A valid token for another job answers exactly like an unknown token.
    if (!presented || !token || token.jobId !== jobId) return unauthorized(reply);
    if (presented.viaQuery && !warned.has(token.id)) {
      warned.add(token.id);
      deps.logger.warn({ tokenId: token.id, jobId }, "Webhook token sent in the query string; prefer the Authorization header");
    }
    const wait = limiter.check(token.id);
    if (wait > 0) return reply.code(429).header("retry-after", String(wait)).send({ error: "Too many requests" });
    deps.stores.tokens.touch(token.id);
    const { code, body } = mapTrigger(deps.manager.trigger(jobId, "webhook"));
    return reply.code(code).header("cache-control", "no-store").send(body);
  });
}
