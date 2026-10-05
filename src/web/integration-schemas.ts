import { z } from "zod";
import { endpointOrigin, FIELDS, parseChannelConfig } from "../post/notify/config.js";
import { hasUserinfo, httpUrlSchema, originOf } from "../post/url-schema.js";
import { CHANNEL_KINDS, type ChannelKind } from "../store/channel-store.js";
import { NOTIFY_ON, type JobIntegration } from "../store/integration-store.js";
import { bodyStrings, fieldErrors, type FormErrors } from "./host-schemas.js";

const name = z.string().trim().min(1, "Name is required").max(80, "At most 80 characters");
const httpUrl = httpUrlSchema("a full URL such as http://sonarr:8989");

const arrSchema = z.object({ name, kind: z.enum(["sonarr", "radarr"]), url: httpUrl, api_key: z.string().default("") });
export type ArrForm = { name: string; kind: "sonarr" | "radarr"; url: string; apiKey: string };

/**
 * `apiKey` may be blank only when `requireKey` is false (edit: blank keeps the stored key). When `previousUrl` (the stored URL)
 * is on a different origin, a blank key is rejected: the stored key must never be sent to a new host without re-entry.
 */
export function parseArrForm(body: unknown, requireKey: boolean, previousUrl?: string): { ok: true; data: ArrForm } | { ok: false; errors: FormErrors } {
  const r = arrSchema.safeParse(bodyStrings(body));
  if (!r.success) return { ok: false, errors: fieldErrors(r.error) };
  const apiKey = r.data.api_key.trim();
  if (requireKey && apiKey === "") return { ok: false, errors: { api_key: "API key is required" } };
  if (apiKey === "" && previousUrl !== undefined && originOf(previousUrl) !== originOf(r.data.url)) {
    return { ok: false, errors: { api_key: "The URL points to a different server: enter the API key again" } };
  }
  return { ok: true, data: { name: r.data.name, kind: r.data.kind, url: r.data.url, apiKey } };
}

/** Values to re-render the form with. A URL that carries credentials is not echoed back into the page. */
export const arrValues = (body: unknown): Record<string, string> => {
  const b = bodyStrings(body);
  const url = (b["url"] ?? "").trim();
  return { name: b["name"] ?? "", kind: b["kind"] ?? "sonarr", url: hasUserinfo(url) ? "" : url };
};

export const isChannelKind = (v: string | undefined): v is ChannelKind => !!v && (CHANNEL_KINDS as readonly string[]).includes(v);

export type ChannelForm = { name: string; enabled: boolean; config: Record<string, string> };

/**
 * Config fields are posted as `cfg_<key>`. A blank secret field keeps the stored value (`stored`); blank non-secret fields clear it.
 */
export function parseChannelForm(kind: ChannelKind, body: unknown, stored: Record<string, string> | null): { ok: true; data: ChannelForm } | { ok: false; errors: FormErrors } {
  const b = bodyStrings(body);
  const n = name.safeParse(b["name"] ?? "");
  const raw: Record<string, string> = {};
  for (const f of FIELDS[kind]) {
    const posted = (b[`cfg_${f.key}`] ?? "").trim();
    raw[f.key] = f.secret && posted === "" ? stored?.[f.key] ?? "" : posted;
  }
  const cfg = parseChannelConfig(kind, raw);
  const errors: FormErrors = { ...movedEndpointErrors(kind, b, raw, stored) };
  if (!n.success) errors["name"] = n.error.issues[0]?.message ?? "Invalid name";
  if (!cfg.ok) for (const [k, v] of Object.entries(cfg.errors)) errors[`cfg_${k}`] = v;
  if (!n.success || !cfg.ok || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, data: { name: n.data, enabled: b["enabled"] === "on", config: cfg.config } };
}

/** A blank secret is kept from the stored config, but not when the endpoint moved to another origin: it must be typed again. */
function movedEndpointErrors(kind: ChannelKind, posted: Record<string, string>, raw: Record<string, string>, stored: Record<string, string> | null): FormErrors {
  if (!stored || endpointOrigin(kind, raw) === endpointOrigin(kind, stored)) return {};
  const kept = FIELDS[kind].filter((f) => f.secret && (posted[`cfg_${f.key}`] ?? "").trim() === "" && (stored[f.key] ?? "") !== "");
  return Object.fromEntries(kept.map((f) => [`cfg_${f.key}`, `The server address changed: enter the ${f.label.toLowerCase()} again`]));
}

/** Non-secret values for re-rendering a channel form. Secrets are never included. */
export function channelValues(kind: ChannelKind, source: Record<string, string>): Record<string, string> {
  return Object.fromEntries(FIELDS[kind].filter((f) => !f.secret).map((f) => [f.key, source[f.key] ?? ""]));
}

export function postedChannelValues(kind: ChannelKind, body: unknown): Record<string, string> {
  const b = bodyStrings(body);
  return Object.fromEntries(FIELDS[kind].filter((f) => !f.secret).map((f) => [f.key, hasUserinfo(b[`cfg_${f.key}`] ?? "") ? "" : (b[`cfg_${f.key}`] ?? "")]));
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string");

/** Job integration form. Unknown arr targets or channels are dropped by the caller via the `known` sets. */
export function parseJobIntegration(body: unknown, known: { arr: Set<number>; channels: Set<number> }): { ok: true; data: JobIntegration } | { ok: false; errors: FormErrors } {
  const b = bodyStrings(body);
  const notifyOn = (NOTIFY_ON as readonly string[]).includes(b["notify_on"] ?? "") ? (b["notify_on"] as JobIntegration["notifyOn"]) : null;
  const arrId = /^\d{1,9}$/.test(b["arr_target_id"] ?? "") ? Number(b["arr_target_id"]) : null;
  const arrTargetId = arrId !== null && known.arr.has(arrId) ? arrId : null;
  const arrPath = (b["arr_path"] ?? "").trim();
  const errors: FormErrors = {};
  if (!notifyOn) errors["notify_on"] = "Choose when to notify";
  if (arrTargetId !== null && arrPath === "") errors["arr_path"] = "Enter the folder as the *arr container sees it";
  if (arrPath.length > 1000) errors["arr_path"] = "Too long";
  if (!notifyOn || Object.keys(errors).length > 0) return { ok: false, errors };
  const raw = (body && typeof body === "object" ? (body as Record<string, unknown>)["channel"] : undefined);
  const ids = asList(raw).filter((s) => /^\d{1,9}$/.test(s)).map(Number).filter((id) => known.channels.has(id));
  return { ok: true, data: { arrTargetId, arrPath: arrTargetId === null && arrPath === "" ? null : arrPath, notifyOn, notifyChannelIds: [...new Set(ids)] } };
}
