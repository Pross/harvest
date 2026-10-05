import type { Logger } from "../../logger.js";
import type { ChannelConfig, ChannelKind } from "../../store/channel-store.js";
import type { NotifyOn } from "../../store/integration-store.js";
import type { Stores } from "../../store/index.js";
import type { RunState } from "../../domain.js";
import { explainError } from "../explain.js";
import { IntegrationHttpError } from "../http.js";
import type { RunNotifier, RunSummary } from "../types.js";
import { parseChannelConfig } from "./config.js";
import { sendDiscord } from "./discord.js";
import { sendNtfy } from "./ntfy.js";
import { sendPushover } from "./pushover.js";
import { sendTelegram } from "./telegram.js";
import { truncate, type NotifyEvent, type Sender } from "./types.js";
import { sendWebhook } from "./webhook.js";

export { FIELDS, parseChannelConfig } from "./config.js";
export type { NotifyEvent } from "./types.js";

const SENDERS: Record<ChannelKind, Sender> = { ntfy: sendNtfy, discord: sendDiscord, telegram: sendTelegram, pushover: sendPushover, webhook: sendWebhook };

type NotifierStores = Pick<Stores, "integrations" | "channels" | "activity">;

const FAILURE: RunState[] = ["failed", "partial", "skipped_space"];

/** never: nothing; failure: failed, partial or skipped_space; success: succeeded; always: every terminal state (also cancelled and skipped). */
export function shouldNotify(mode: NotifyOn, state: RunState): boolean {
  if (mode === "never") return false;
  if (mode === "always") return true;
  return mode === "failure" ? FAILURE.includes(state) : state === "succeeded";
}

const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

export function buildEvent(job: { name: string }, runId: number, state: RunState, s: RunSummary): NotifyEvent {
  const lines = [
    `Job ${job.name}, run #${runId}: ${state}`,
    `Files ok ${s.filesOk}, failed ${s.filesFailed}, skipped ${s.filesSkipped}; ${mb(s.bytesDone)} in ${Math.round(s.durationMs / 1000)} s`,
  ];
  if (s.error) lines.push(`Error: ${truncate(s.error, 300)}`);
  if (s.warnings.length > 0) lines.push(`Warnings: ${s.warnings.length} (first: ${truncate(s.warnings[0] ?? "", 200)})`);
  return { title: truncate(`Harvest: ${job.name} ${state}`, 100), text: truncate(lines.join("\n"), 900), job: job.name, runId, state, summary: s };
}

/** Delivers one event. Throws IntegrationHttpError on failure (message without URL or secrets). */
export async function sendToChannel(ch: ChannelConfig, event: NotifyEvent, signal?: AbortSignal): Promise<void> {
  const parsed = parseChannelConfig(ch.kind, ch.config);
  if (!parsed.ok) throw new IntegrationHttpError(`invalid stored config (${Object.keys(parsed.errors).join(", ")})`);
  await SENDERS[ch.kind](parsed.config, event, signal);
}

const UNREADABLE = "channel config could not be read (APP_SECRET changed?)";

/** Returns a warning text on failure. Recording it as activity is the caller's job (the executor or the early notifier). */
async function deliver(stores: NotifierStores, logger: Logger, id: number, event: NotifyEvent, signal: AbortSignal | undefined): Promise<string | null> {
  const pub = stores.channels.getPublic(id);
  if (!pub || !pub.enabled) return null;
  try {
    await sendToChannel(stores.channels.getConfig(id), event, signal);
    return null;
  } catch (err) {
    const why = explainError(err, logger, { channel: pub.name, kind: pub.kind }, UNREADABLE);
    return `notification ${pub.name} failed: ${why}`;
  }
}

/** One channel failing never blocks the others; failures become warnings. */
export function createRunNotifier(stores: NotifierStores, logger: Logger): RunNotifier {
  return {
    async run({ job, runId, state, summary, signal }) {
      const link = stores.integrations.get(job.id);
      if (!shouldNotify(link.notifyOn, state) || link.notifyChannelIds.length === 0) return { warnings: [] };
      const event = buildEvent(job, runId, state, summary);
      const results = await Promise.all(link.notifyChannelIds.map((id) => deliver(stores, logger, id, event, signal)));
      return { warnings: results.filter((w): w is string => w !== null) };
    },
  };
}
