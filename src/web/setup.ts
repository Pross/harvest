import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { constantTimeEqual, hashPassword, randomToken } from "../crypto.js";
import type { AppDeps } from "./deps.js";
import { redirectTo, render } from "./helpers.js";
import { countUsers, createFirstUser } from "./sessions.js";

/** One-time first-run state. `token` is non-null only while no user exists and no env bootstrap happened. */
export type SetupState = { token: string | null };

/**
 * First run (AUTH_MODE=builtin only): when NO user exists, create one from ADMIN_USER/ADMIN_PASS;
 * if those are not both set, generate a one-time setup token (memory only) and log the setup URL ONCE.
 * Never overwrites an existing user.
 */
export async function ensureAdmin(deps: AppDeps): Promise<SetupState> {
  const { config, logger, db } = deps;
  if (config.AUTH_MODE !== "builtin" || countUsers(db) > 0) return { token: null };
  if (config.ADMIN_USER && config.ADMIN_PASS) {
    createFirstUser(db, config.ADMIN_USER, await hashPassword(config.ADMIN_PASS));
    logger.info({ username: config.ADMIN_USER }, "Created the admin user from ADMIN_USER/ADMIN_PASS");
    return { token: null };
  }
  const token = randomToken(24);
  const base = config.PUBLIC_URL ?? `http://localhost:${config.PORT}`;
  // Deliberately logged (once): the operator needs it. Key is not "token" so pino redaction leaves it.
  logger.warn({ setupUrl: `${base}/setup?token=${token}` }, "No user exists yet. Open this URL to create the first user");
  return { token };
}

const SetupBody = z.object({
  token: z.string(),
  username: z.string().trim().min(1, "Enter a username.").max(100),
  password: z.string().min(8, "Use at least 8 characters.").max(1000),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match." });

const tokenOk = (state: SetupState, presented: unknown): boolean =>
  state.token !== null && typeof presented === "string" && constantTimeEqual(presented, state.token);

export function registerSetup(app: FastifyInstance, deps: AppDeps, state: SetupState): void {
  const open = (): boolean => deps.config.AUTH_MODE === "builtin" && state.token !== null && countUsers(deps.db) === 0;
  app.get("/setup", async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (!open() || !tokenOk(state, token)) return reply.callNotFound();
    return render(reply, deps, "setup.eta", { title: "Create the first user", token, errors: {}, username: "" });
  });
  app.post("/setup", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!open() || !tokenOk(state, body["token"])) return reply.callNotFound();
    const parsed = SetupBody.safeParse(body);
    if (!parsed.success) {
      const errors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
      return render(reply, deps, "setup.eta", { title: "Create the first user", token: state.token, errors, username: String(body["username"] ?? "") }, 400);
    }
    const created = createFirstUser(deps.db, parsed.data.username, await hashPassword(parsed.data.password));
    if (created) state.token = null;
    if (!created) return reply.callNotFound();
    return redirectTo(reply, "/login", { kind: "ok", message: "User created. Sign in below." });
  });
}
