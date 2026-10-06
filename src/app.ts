import type { FastifyInstance } from "fastify";
import { buildRunPipeline, type RunPipeline } from "./app-run.js";
import type { Config } from "./config.js";
import { decryptSecret, encryptSecret, resolveAppSecret } from "./crypto.js";
import { openDb, type DB } from "./db.js";
import { createRcloneEngine } from "./engine/rclone-engine.js";
import type { TransferEngine } from "./engine/types.js";
import type { Logger } from "./logger.js";
import { recoverPromoting } from "./run/recovery.js";
import { createScheduler, type Scheduler } from "./schedule/scheduler.js";
import { startMaintenance, type MaintenanceDeps } from "./schedule/maintenance.js";
import { createStores, type Stores } from "./store/index.js";
import { checkStoredSecrets } from "./web/host-config.js";
import { registerActivityRoutes } from "./web/routes-activity.js";
import { registerBrowseRoutes } from "./web/routes-browse.js";
import { registerHostProbeRoutes } from "./web/routes-host-probe.js";
import { registerHostRoutes } from "./web/routes-hosts.js";
import { registerDryRunRoutes } from "./web/routes-dryrun.js";
import { registerHookRoutes } from "./web/routes-hooks.js";
import { registerIntegrationRoutes } from "./web/routes-integrations.js";
import { registerTokenRoutes } from "./web/routes-tokens.js";
import { registerPostRoutes } from "./web/routes-post.js";
import { registerJobRoutes } from "./web/routes-jobs.js";
import { registerLedgerRoutes } from "./web/routes-ledger.js";
import { registerRunsRoutes } from "./web/routes-runs.js";
import { registerSettingsRoutes } from "./web/routes-settings.js";
import { buildServer } from "./web/server.js";
import { readSettings, readSettingsOrDefault } from "./web/settings-schema.js";
import type { AppDeps } from "./web/deps.js";

export type App = { server: FastifyInstance; start(): Promise<void>; stop(): Promise<void> };

const ROUTES = [
  registerHostRoutes, registerHostProbeRoutes, registerJobRoutes, registerBrowseRoutes, registerRunsRoutes,
  registerActivityRoutes, registerLedgerRoutes, registerSettingsRoutes, registerDryRunRoutes, registerHookRoutes, registerTokenRoutes, registerIntegrationRoutes, registerPostRoutes,
];

function maintenanceQueries(db: DB, stores: ReturnType<typeof createStores>) {
  return {
    purgeSessions: (now: number) => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now).changes,
    stalePartials: (olderThanMs: number) => stores.partials.listOlderThan(olderThanMs),
  };
}

type Core = {
  db: DB;
  stores: Stores;
  engine: TransferEngine;
  secretSource: AppDeps["appSecretSource"];
  settings: ReturnType<typeof readSettings>;
};

function buildCore(config: Config, logger: Logger): Core {
  const secret = resolveAppSecret({ env: config.APP_SECRET, configDir: config.CONFIG_DIR });
  if (secret.source === "generated") logger.warn("APP_SECRET was generated and stored in CONFIG_DIR/.app_secret; back it up separately from the database");
  const db = openDb(config.dbPath);
  const stores = createStores(db, {
    encrypt: (p) => encryptSecret(p, secret.secret),
    decrypt: (b) => decryptSecret(b, secret.secret),
  });
  const engine = createRcloneEngine({ rclone: config.RCLONE_BIN, tmpDir: config.tmpDir, connectTimeoutMs: config.CONNECT_TIMEOUT_SECONDS * 1000 });
  checkStoredSecrets({ stores, logger });
  return { db, stores, engine, secretSource: secret.source, settings: readSettingsOrDefault(stores, logger) };
}

function buildDeps(config: Config, logger: Logger, core: Core, pipe: RunPipeline, scheduler: Scheduler, maint: MaintenanceDeps): AppDeps {
  const { stores } = core;
  return {
    config, db: core.db, stores, engine: core.engine, manager: pipe.manager, scheduler, bus: pipe.bus, logger,
    appSecretSource: core.secretSource,
    onJobsChanged: () => scheduler.reload(),
    onSettingsChanged: () => {
      const s = readSettingsOrDefault(stores, logger);
      pipe.bandwidth.refresh();
      maint.retention = s.retention;
    },
  };
}

/** Loud startup warnings for settings that weaken the web security model. */
export function warnInsecureConfig(config: Config, logger: Logger): void {
  if (config.AUTH_MODE === "none" && !config.ALLOWED_HOSTS?.length) {
    logger.warn("AUTH_MODE=none without ALLOWED_HOSTS: anyone who can reach this port has full control, and a DNS rebinding attack can pass the Origin check. Set ALLOWED_HOSTS (and PUBLIC_URL) to the host names you use");
  }
  if (config.TRUST_PROXY === true) {
    logger.warn("TRUST_PROXY=true trusts any X-Forwarded-For value, so clients can spoof their IP and bypass the login throttle unless the proxy overwrites that header. Prefer a hop count (TRUST_PROXY=1) or the proxy's address");
  }
}

export async function createApp(config: Config, logger: Logger): Promise<App> {
  warnInsecureConfig(config, logger);
  const core = buildCore(config, logger);
  const { stores, engine, db } = core;
  const pipe = buildRunPipeline({ config, stores, engine, logger, readBandwidth: () => readSettings(stores) });
  const scheduler = createScheduler({ stores, manager: pipe.manager, logger, tz: config.TZ });
  const maintenanceAbort = new AbortController();
  const maint: MaintenanceDeps = { stores, engine, logger, signal: maintenanceAbort.signal, slotsFor: pipe.slotsFor, busyJobs: () => pipe.manager.busyJobIds(), retention: core.settings.retention, tz: config.TZ, ...maintenanceQueries(db, stores) };
  const server = await buildServer(buildDeps(config, logger, core, pipe, scheduler, maint), ROUTES);
  return lifecycle({ config, logger, db, stores, server, pipe, scheduler, maint, maintenanceAbort });
}

type Parts = { config: Config; logger: Logger; db: DB; stores: Stores; server: FastifyInstance; pipe: RunPipeline; scheduler: Scheduler; maint: MaintenanceDeps; maintenanceAbort: AbortController };

function lifecycle(p: Parts): App {
  let stopMaintenance = async (): Promise<void> => {};
  return {
    server: p.server,
    async start() {
      p.logger.info({ failed: p.pipe.manager.recoverOnBoot() }, "failed interrupted runs from the previous process");
      p.logger.info(await recoverPromoting({ stores: p.stores, logger: p.logger }), "recovered interrupted promotes");
      p.pipe.bandwidth.refresh();
      p.scheduler.start();
      stopMaintenance = startMaintenance(p.maint);
      await p.server.listen({ host: p.config.HOST, port: p.config.PORT });
    },
    /** Stop taking requests first (closing SSE streams), then new scheduled work, then drain runs, then close the DB. */
    async stop() {
      await p.server.close();
      p.pipe.bandwidth.stop();
      p.scheduler.stop();
      p.maintenanceAbort.abort();
      await stopMaintenance();
      await p.pipe.manager.stop();
      p.db.close();
    },
  };
}
