import { z } from "zod";
import type { ChannelKind } from "../../store/channel-store.js";
import { httpUrlSchema, originOf } from "../url-schema.js";

export type FieldSpec = { key: string; label: string; secret: boolean; required: boolean; hint?: string };

const httpUrl = httpUrlSchema();
const optUrl = z.union([z.literal(""), httpUrl]).optional();
const req = (label: string) => z.string().trim().min(1, `${label} is required`);
const opt = z.string().trim().optional();

const SCHEMAS = {
  ntfy: z.object({ server: optUrl, topic: req("Topic"), token: opt }),
  discord: z.object({ webhookUrl: httpUrl }),
  telegram: z.object({ botToken: req("Bot token"), chatId: req("Chat ID"), server: optUrl }),
  pushover: z.object({ appToken: req("Application token"), userKey: req("User key"), server: optUrl }),
  webhook: z.object({ url: httpUrl, bearerToken: opt }),
} as const;

export const FIELDS: Record<ChannelKind, FieldSpec[]> = {
  ntfy: [
    { key: "server", label: "Server URL", secret: false, required: false, hint: "Blank uses https://ntfy.sh" },
    { key: "topic", label: "Topic", secret: true, required: true, hint: "On a public ntfy server the topic name is the only protection, so it is stored like a password" },
    { key: "token", label: "Access token", secret: true, required: false },
  ],
  discord: [{ key: "webhookUrl", label: "Webhook URL", secret: true, required: true }],
  telegram: [
    { key: "botToken", label: "Bot token", secret: true, required: true },
    { key: "chatId", label: "Chat ID", secret: false, required: true },
    { key: "server", label: "API server URL", secret: false, required: false, hint: "Blank uses https://api.telegram.org" },
  ],
  pushover: [
    { key: "appToken", label: "Application token", secret: true, required: true },
    { key: "userKey", label: "User key", secret: true, required: true },
    { key: "server", label: "API server URL", secret: false, required: false, hint: "Blank uses https://api.pushover.net" },
  ],
  webhook: [
    { key: "url", label: "URL", secret: true, required: true, hint: "Receives a JSON POST. Stored encrypted and never shown again" },
    { key: "bearerToken", label: "Bearer token", secret: true, required: false },
  ],
};

export type ConfigResult = { ok: true; config: Record<string, string> } | { ok: false; errors: Record<string, string> };

/** Validates a flat string config for the kind. Unknown keys are dropped; empty optional values are removed. */
export function parseChannelConfig(kind: ChannelKind, raw: Record<string, string>): ConfigResult {
  const r = SCHEMAS[kind].safeParse(raw);
  if (!r.success) {
    const errors: Record<string, string> = {};
    for (const i of r.error.issues) errors[String(i.path[0])] ??= i.message;
    return { ok: false, errors };
  }
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.data)) if (typeof v === "string" && v !== "") config[k] = v;
  return { ok: true, config };
}

/** Where each channel kind sends its credentials: the config key of the endpoint and the default server used when it is blank. */
const ENDPOINT: Record<ChannelKind, { key: string; fallback: string | null }> = {
  ntfy: { key: "server", fallback: "https://ntfy.sh" },
  discord: { key: "webhookUrl", fallback: null },
  telegram: { key: "server", fallback: "https://api.telegram.org" },
  pushover: { key: "server", fallback: "https://api.pushover.net" },
  webhook: { key: "url", fallback: null },
};

/** Origin (scheme, host, port) that receives this channel's secrets, or null when it cannot be determined. */
export function endpointOrigin(kind: ChannelKind, config: Record<string, string>): string | null {
  const e = ENDPOINT[kind];
  return originOf(config[e.key] || e.fallback || undefined);
}
