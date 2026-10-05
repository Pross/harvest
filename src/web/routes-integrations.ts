import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./deps.js";
import { registerArrRoutes } from "./routes-arr.js";
import { registerChannelRoutes } from "./routes-channels.js";
import { registerJobIntegrationRoutes } from "./routes-job-integrations.js";

/** *arr targets, notification channels, and the per-job wiring page. */
export function registerIntegrationRoutes(app: FastifyInstance, deps: AppDeps): void {
  registerArrRoutes(app, deps);
  registerChannelRoutes(app, deps);
  registerJobIntegrationRoutes(app, deps);
}
