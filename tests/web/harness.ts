import type { FastifyInstance, InjectOptions } from "fastify";
import { Writable } from "node:stream";
import { loadConfig, type Config } from "../../src/config.js";
import { hashPassword } from "../../src/crypto.js";
import { openDb } from "../../src/db.js";
import { buildLogger } from "../../src/logger.js";
import { createEventBus } from "../../src/run/events.js";
import type { ActiveRun } from "../../src/run/manager-types.js";
import { createStores } from "../../src/store/index.js";
import type { AppDeps } from "../../src/web/deps.js";
import { buildServer, type RouteRegistrar, type ServerOptions } from "../../src/web/server.js";
import { createFirstUser } from "../../src/web/sessions.js";

export const HOST = "harvest.test";
export const ORIGIN = `http://${HOST}`;
export const PASSWORD = "correct-horse-battery";
let cachedHash: string | undefined;

export type Harness = {
  app: FastifyInstance; deps: AppDeps; logs: string[];
  active: ActiveRun[]; next: { jobId: number; next: Date | null }[];
};

export type HarnessOptions = {
  env?: Record<string, string>; user?: boolean; secretSource?: AppDeps["appSecretSource"];
  routes?: RouteRegistrar[]; server?: ServerOptions;
  /** Replaces the fake credential crypto (e.g. to make decrypt fail like a changed APP_SECRET). */
  crypto?: { encrypt: (p: string) => Buffer; decrypt: (b: Buffer) => string };
};

export async function makeHarness(o: HarnessOptions = {}): Promise<Harness> {
  const logs: string[] = [];
  const sink = new Writable({ write(chunk, _enc, cb) { logs.push(String(chunk)); cb(); } });
  const config: Config = loadConfig({ NODE_ENV: "test", CONFIG_DIR: "/tmp/harvest-web-test", ...o.env });
  const db = openDb(":memory:");
  const crypto = o.crypto ?? { encrypt: (p: string) => Buffer.from(p), decrypt: (b: Buffer) => b.toString() };
  const active: ActiveRun[] = [];
  const next: { jobId: number; next: Date | null }[] = [];
  const deps: AppDeps = {
    config, db, stores: createStores(db, crypto), engine: {} as AppDeps["engine"],
    manager: { trigger: () => ({ status: "disabled" }), cancel: () => false, active: () => active, stop: async () => {} },
    scheduler: { nextRuns: () => next }, bus: createEventBus(), logger: buildLogger("info", false, sink),
    appSecretSource: o.secretSource ?? "env", onJobsChanged: () => {}, onSettingsChanged: () => {},
  };
  if (o.user !== false) {
    cachedHash ??= await hashPassword(PASSWORD);
    createFirstUser(db, "admin", cachedHash);
  }
  const app = await buildServer(deps, o.routes ?? [], o.server);
  return { app, deps, logs, active, next };
}

export const cookieOf = (res: { cookies: { name: string; value: string }[] }, name: string): string | undefined =>
  res.cookies.find((c) => c.name === name)?.value;

export const csrfOf = (html: string): string => /x-csrf-token&quot;:&quot;([^&]*)&quot;/.exec(html)?.[1] ?? "";

export function req(h: Harness, opts: InjectOptions & { sid?: string; origin?: string | null }) {
  const headers: Record<string, string> = { host: HOST, ...(opts.headers as Record<string, string> | undefined) };
  if (opts.origin !== null && opts.method && opts.method !== "GET") headers["origin"] = opts.origin ?? ORIGIN;
  if (opts.sid) headers["cookie"] = `harvest_sid=${opts.sid}`;
  return h.app.inject({ ...opts, headers });
}

export async function login(h: Harness, password = PASSWORD) {
  return req(h, { method: "POST", url: "/login", payload: { username: "admin", password }, sid: undefined });
}

/** Logs in and returns the session cookie plus the CSRF token read from the dashboard HTML. */
export async function session(h: Harness): Promise<{ sid: string; csrf: string }> {
  const res = await login(h);
  const sid = cookieOf(res, "harvest_sid") ?? "";
  const page = await req(h, { method: "GET", url: "/", sid });
  return { sid, csrf: csrfOf(page.body) };
}
