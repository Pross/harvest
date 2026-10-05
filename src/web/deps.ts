import type { Config } from "../config.js";
import type { DB } from "../db.js";
import type { Logger } from "../logger.js";
import type { TransferEngine } from "../engine/types.js";
import type { EventBus } from "../run/events.js";
import type { RunManager } from "../run/manager-types.js";
import type { Stores } from "../store/index.js";

/** Read-only view of the scheduler for the dashboard and job pages. */
export interface SchedulerView {
  nextRuns(): { jobId: number; next: Date | null }[];
}

/** Everything a route module may use. Frozen contract: each routes-*.ts exports `registerXRoutes(app, deps)`. */
export type AppDeps = {
  config: Config;
  db: DB;
  stores: Stores;
  engine: TransferEngine;
  manager: RunManager;
  scheduler: SchedulerView;
  bus: EventBus;
  logger: Logger;
  /** Where the app secret came from; "generated" makes the UI show a banner. */
  appSecretSource: "env" | "file" | "generated";
  /** Called after jobs are created/updated/deleted so the scheduler re-reads schedules. */
  onJobsChanged: () => void;
  /** Called after the settings page saves, so index.ts can apply the global bandwidth limit etc. */
  onSettingsChanged: () => void;
};
