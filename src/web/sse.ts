import type { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppEvent } from "../run/events.js";
import type { AppDeps } from "./deps.js";
import { activeTransfersData } from "./routes-dashboard.js";
import { renderToString } from "./helpers.js";
import type { SessionStore } from "./sessions.js";
import { MAX_STREAMS, type Stream } from "./stream-hub.js";

export const HEARTBEAT_MS = 15_000;
export const PROGRESS_MIN_INTERVAL_MS = 1000;

export type SseOptions = { now?: () => number; heartbeatMs?: number };

/** Frames one named event; multi-line data becomes multiple `data:` lines. */
export function frame(event: string, data: string): string {
  return `event: ${event}\n${data.split("\n").map((l) => `data: ${l}`).join("\n")}\n\n`;
}

/** Per-run throttle: true at most once per interval for each run id. */
export class ProgressThrottle {
  private readonly last = new Map<number, number>();
  constructor(private readonly now: () => number, private readonly minMs = PROGRESS_MIN_INTERVAL_MS) {}
  take(runId: number): boolean {
    const t = this.now();
    const prev = this.last.get(runId);
    if (prev !== undefined && t - prev < this.minMs) return false;
    this.last.set(runId, t);
    return true;
  }
  forget(runId: number): void {
    this.last.delete(runId);
  }
}

async function toFrames(app: FastifyInstance, deps: AppDeps, e: AppEvent, throttle: ProgressThrottle): Promise<string[]> {
  if (e.type === "run.progress") {
    if (!throttle.take(e.runId)) return [];
    const html = await renderToString(app, "partials/active-transfers.eta", { ...activeTransfersData(deps), authMode: deps.config.AUTH_MODE });
    return [frame("run-progress", html)];
  }
  if (e.type === "run.state") {
    throttle.forget(e.runId);
    return [frame("run-state", `${e.runId}:${e.state}`)];
  }
  if (e.type === "activity") return [frame("activity", String(e.id))];
  return [];
}

/**
 * GET /events: SSE over reply.raw (no dependency). Behind the global auth hook like every non-public path.
 * Streams are capped (503 beyond MAX_STREAMS), closed on logout and password change through app.streams, and
 * closed by the heartbeat tick once their session has expired or been deleted.
 */
export function registerSse(app: FastifyInstance, deps: AppDeps, sessions: SessionStore, opts: SseOptions = {}): void {
  app.addHook("onClose", async () => app.streams.closeAll());
  app.get("/events", (req, reply) => {
    if (app.streams.size >= MAX_STREAMS) return reply.code(503).header("retry-after", "10").type("text/plain").send("Too many open event streams");
    reply.hijack();
    openStream(app, deps, sessions, opts, req, reply.raw);
  });
}

function openStream(app: FastifyInstance, deps: AppDeps, sessions: SessionStore, opts: SseOptions, req: FastifyRequest, raw: ServerResponse): void {
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
    connection: "keep-alive", "x-accel-buffering": "no",
  });
  raw.write(": connected\n\n");
  const throttle = new ProgressThrottle(opts.now ?? Date.now);
  const send = (chunk: string) => { if (!raw.writableEnded) raw.write(chunk); };
  const sessionId = req.auth.sessionId;
  const stream: Stream = { sessionId, userId: req.auth.user?.id ?? null, close: () => close() };
  const heartbeat = setInterval(() => {
    if (sessionId && !sessions.exists(sessionId)) return close();
    send(": heartbeat\n\n");
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  const unsubscribe = deps.bus.subscribe((e) => {
    toFrames(app, deps, e, throttle).then((fs) => fs.forEach(send), (err: unknown) => deps.logger.error({ err }, "SSE render failed"));
  });
  function close(): void {
    clearInterval(heartbeat);
    unsubscribe();
    app.streams.remove(stream);
    if (!raw.writableEnded) raw.end();
  }
  app.streams.add(stream);
  req.raw.on("close", close);
}
