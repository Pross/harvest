import type { DB } from "../db.js";
import { SqliteActivityStore } from "./activity-store.js";
import { SqliteArrStore } from "./arr-store.js";
import { SqliteChannelStore } from "./channel-store.js";
import { SqliteIntegrationStore } from "./integration-store.js";
import { SqliteHostStore, type Crypto } from "./host-store.js";
import { SqliteJobStore } from "./job-store.js";
import { SqliteLedgerStore } from "./ledger-store.js";
import { SqliteObservationStore } from "./observation-store.js";
import { SqlitePartialsStore } from "./partials-store.js";
import { SqlitePostStore } from "./post-store.js";
import { SqliteRunStore } from "./run-store.js";
import { SqliteSettingsStore } from "./settings-store.js";
import { SqliteTokenStore } from "./token-store.js";

export type Stores = ReturnType<typeof createStores>;

export function createStores(db: DB, crypto: Crypto) {
  return {
    partials: new SqlitePartialsStore(db),
    ledger: new SqliteLedgerStore(db),
    observations: new SqliteObservationStore(db),
    activity: new SqliteActivityStore(db),
    runs: new SqliteRunStore(db),
    jobs: new SqliteJobStore(db),
    hosts: new SqliteHostStore(db, crypto),
    settings: new SqliteSettingsStore(db),
    tokens: new SqliteTokenStore(db),
    post: new SqlitePostStore(db),
    arrTargets: new SqliteArrStore(db, crypto),
    channels: new SqliteChannelStore(db, crypto),
    integrations: new SqliteIntegrationStore(db),
  };
}

export * from "./activity-store.js";
export * from "./arr-store.js";
export * from "./channel-store.js";
export * from "./integration-store.js";
export * from "./errors.js";
export * from "./host-store.js";
export * from "./job-store.js";
export * from "./ledger-store.js";
export * from "./observation-store.js";
export * from "./partials-store.js";
export * from "./post-store.js";
export * from "./run-store.js";
export * from "./settings-store.js";
export * from "./token-store.js";
