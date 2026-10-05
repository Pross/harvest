import type { DB } from "../db.js";
import { parseIds } from "./channel-store.js";

export const NOTIFY_ON = ["never", "failure", "success", "always"] as const;
export type NotifyOn = (typeof NOTIFY_ON)[number];
export type JobIntegration = { arrTargetId: number | null; arrPath: string | null; notifyOn: NotifyOn; notifyChannelIds: number[] };

export const DEFAULT_INTEGRATION: JobIntegration = { arrTargetId: null, arrPath: null, notifyOn: "failure", notifyChannelIds: [] };

type IntegrationSql = { arr_target_id: number | null; arr_path: string | null; notify_on: NotifyOn; notify_channel_ids: string };

export class SqliteIntegrationStore {
  constructor(private readonly db: DB) {}

  /** The defaults (no *arr, notify on failure, no channels) when the job has no row. */
  get(jobId: number): JobIntegration {
    const r = this.db.prepare("SELECT * FROM job_integrations WHERE job_id = ?").get(jobId) as IntegrationSql | undefined;
    if (!r) return { ...DEFAULT_INTEGRATION, notifyChannelIds: [] };
    return { arrTargetId: r.arr_target_id, arrPath: r.arr_path, notifyOn: r.notify_on, notifyChannelIds: parseIds(r.notify_channel_ids) };
  }

  set(jobId: number, v: JobIntegration): void {
    this.db.prepare(
      `INSERT INTO job_integrations (job_id, arr_target_id, arr_path, notify_on, notify_channel_ids) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET arr_target_id = excluded.arr_target_id, arr_path = excluded.arr_path,
         notify_on = excluded.notify_on, notify_channel_ids = excluded.notify_channel_ids`,
    ).run(jobId, v.arrTargetId, v.arrPath, v.notifyOn, JSON.stringify(v.notifyChannelIds));
  }
}
