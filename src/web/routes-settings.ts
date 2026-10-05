import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../crypto.js";
import type { DB } from "../db.js";
import { cookieSecure } from "./auth.js";
import { bwFormFromProfiles, hasBwErrors, parseBwForm, type BwForm } from "./bw-profiles-form.js";
import type { AppDeps } from "./deps.js";
import { SESSION_COOKIE, redirectTo, render, runHook, savedFlash } from "./helpers.js";
import { SESSION_TTL_MS, SessionStore, findUser } from "./sessions.js";
import { DEFAULT_SETTINGS, formatRateInput, parseRate, readSettings, writeSettings } from "./settings-schema.js";

const days = z.string().trim().regex(/^-?\d+$/, "Enter a whole number of days.").transform(Number)
  .pipe(z.number().min(1, "Use at least 1 day.").max(3650, "Use at most 3650 days."));

const SettingsBody = z.object({
  bwlimit: z.string().max(40).default("").transform((v, ctx) => {
    const rate = parseRate(v);
    if (rate === undefined) {
      ctx.addIssue({ code: "custom", message: "Use a rate like 10M, 500K or 2G (bytes per second), or leave blank for unlimited." });
      return z.NEVER;
    }
    return rate;
  }),
  activityDays: days, runDays: days, observationDays: days,
});

const PasswordBody = z.object({
  current: z.string().max(1000), password: z.string().min(8, "Use at least 8 characters.").max(1000), confirm: z.string().max(1000),
}).refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match." });

type Errors = Record<string, string>;
type Form = { bwlimit: string; activityDays: string; runDays: string; observationDays: string };

const errorsOf = (err: z.ZodError): Errors => {
  const out: Errors = {};
  for (const i of err.issues) out[String(i.path[0])] ??= i.message;
  return out;
};

const strField = (body: Record<string, unknown>, key: string): string => (typeof body[key] === "string" ? body[key] : "");

/** Corrupt stored settings fall back to defaults so the admin can still open the page and save over them. */
function currentSettings(deps: AppDeps) {
  try {
    return readSettings(deps.stores);
  } catch (err) {
    deps.logger.warn({ err }, "Stored settings are invalid; showing defaults");
    return DEFAULT_SETTINGS;
  }
}

function formFromStore(deps: AppDeps): Form {
  const s = currentSettings(deps);
  return {
    bwlimit: formatRateInput(s.bwlimitGlobalBps), activityDays: String(s.retention.activityDays),
    runDays: String(s.retention.runDays), observationDays: String(s.retention.observationDays),
  };
}

function secretInfo(deps: AppDeps): { source: string; note: string; warn: boolean } {
  if (deps.appSecretSource === "generated") {
    return { source: "generated", warn: true, note: `APP_SECRET was generated and stored in ${deps.config.CONFIG_DIR}/.app_secret; back it up separately from the database.` };
  }
  if (deps.appSecretSource === "file") {
    return { source: "file", warn: false, note: `APP_SECRET was read from ${deps.config.CONFIG_DIR}/.app_secret. Back it up separately from the database.` };
  }
  return { source: "environment", warn: false, note: "APP_SECRET comes from the environment variable. Keep a copy outside this host." };
}

function page(reply: FastifyReply, deps: AppDeps, form: Form, errors: Errors, pwErrors: Errors, status = 200, bw?: BwForm) {
  const s = currentSettings(deps);
  const data = { title: "Settings", nav: "settings", form, errors, pwErrors, bw: bw ?? bwFormFromProfiles(s.bwProfiles, s.bwlimitGlobalBps, new Date()), secret: secretInfo(deps), builtin: deps.config.AUTH_MODE === "builtin" };
  return render(reply, deps, "settings.eta", data, status);
}

async function saveSettings(req: FastifyRequest, reply: FastifyReply, deps: AppDeps) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = SettingsBody.safeParse(body);
  const bw = parseBwForm(body, parsed.success ? parsed.data.bwlimit : currentSettings(deps).bwlimitGlobalBps, new Date());
  if (!parsed.success || hasBwErrors(bw)) {
    const form: Form = { bwlimit: strField(body, "bwlimit"), activityDays: strField(body, "activityDays"), runDays: strField(body, "runDays"), observationDays: strField(body, "observationDays") };
    return page(reply, deps, form, parsed.success ? {} : errorsOf(parsed.error), {}, 400, bw);
  }
  const current = currentSettings(deps);
  const retention = { ...current.retention, activityDays: parsed.data.activityDays, runDays: parsed.data.runDays, observationDays: parsed.data.observationDays };
  writeSettings(deps.db, deps.stores, { bwlimitGlobalBps: parsed.data.bwlimit, bwProfiles: bw.profiles, retention });
  const applied = runHook(deps, () => deps.onSettingsChanged(), "settings");
  return redirectTo(reply, "/settings", savedFlash(applied, "Settings saved."));
}

/** The users and sessions tables have no store; this is the only SQL in the settings routes. */
function replacePassword(db: DB, userId: number, hash: string): void {
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  })();
}

async function passwordErrors(deps: AppDeps, username: string, body: Record<string, unknown>): Promise<{ errors: Errors; newPassword?: string }> {
  const parsed = PasswordBody.safeParse({ current: strField(body, "current"), password: strField(body, "password"), confirm: strField(body, "confirm") });
  const errors: Errors = parsed.success ? {} : errorsOf(parsed.error);
  const user = findUser(deps.db, username);
  if (!errors["current"] && !(user && await verifyPassword(strField(body, "current"), user.passwordHash))) errors["current"] = "Current password is incorrect.";
  return parsed.success && Object.keys(errors).length === 0 ? { errors, newPassword: parsed.data.password } : { errors };
}

async function changePassword(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply, deps: AppDeps) {
  const user = req.auth.user;
  if (deps.config.AUTH_MODE !== "builtin" || !user) return reply.callNotFound();
  if (!app.attempts.allow("password", req.ip, user.username)) {
    return page(reply, deps, formFromStore(deps), {}, { current: "Too many attempts. Wait a minute and try again." }, 429);
  }
  const { errors, newPassword } = await passwordErrors(deps, user.username, (req.body ?? {}) as Record<string, unknown>);
  if (newPassword === undefined) return page(reply, deps, formFromStore(deps), {}, errors, 400);
  replacePassword(deps.db, user.id, await hashPassword(newPassword));
  app.streams.closeUser(user.id);
  const session = new SessionStore(deps.db).create(user.id);
  reply.setCookie(SESSION_COOKIE, session.id, {
    path: "/", httpOnly: true, sameSite: "lax", secure: cookieSecure(req, deps), maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return redirectTo(reply, "/settings", { kind: "ok", message: "Password changed. Other sessions were signed out." });
}

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/settings", async (_req, reply) => page(reply, deps, formFromStore(deps), {}, {}));
  app.post("/settings", (req, reply) => saveSettings(req, reply, deps));
  app.post("/settings/password", (req, reply) => changePassword(app, req, reply, deps));
}
