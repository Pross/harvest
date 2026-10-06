import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HostConfig } from "../domain.js";
import { probeHost } from "../engine/probe.js";
import type { AppDeps } from "./deps.js";
import { render, renderFragment } from "./helpers.js";
import { friendlyConnectionError } from "./host-schemas.js";
import { configFromForm } from "./routes-hosts.js";

const isHtmx = (req: FastifyRequest): boolean => req.headers["hx-request"] === "true";

const TLS_FAILURE = /tls:|x509|certificate/i;

/** A certificate problem is the expected reason a verified method fails, so say that instead of showing rclone's raw error. */
function explain(err: unknown, secret: HostConfig["secret"]): string {
  if (err instanceof Error && TLS_FAILURE.test(err.message)) return "the TLS certificate could not be verified (self-signed, expired or from an unknown authority)";
  return friendlyConnectionError(err, secret).message;
}

/** "Detect best settings" on the host form: probes the posted (unsaved) values and renders the findings with an apply button. */
export function registerHostProbeRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/hosts/probe", async (req, reply) => {
    const built = configFromForm(deps, req.body);
    const data = "error" in built
      ? { result: null, error: `Fix the form first: ${built.error}` }
      : { result: await probeHost(deps.engine, built.cfg, (e) => explain(e, built.cfg.secret)), error: null };
    if (isHtmx(req)) return renderFragment(reply, deps, "partials/host-probe-result.eta", data);
    return render(reply, deps, "partials/host-probe-page.eta", { title: "Detect best settings", nav: "hosts", ...data });
  });
}
