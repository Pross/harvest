import { httpRequest } from "../http.js";
import type { Sender } from "./types.js";

/** POSTs the event as JSON, with an optional bearer token. */
export const sendWebhook: Sender = async (config, event, signal) => {
  await httpRequest({
    url: config["url"] ?? "", method: "POST", ...(signal ? { signal } : {}),
    headers: config["bearerToken"] ? { authorization: `Bearer ${config["bearerToken"]}` } : {},
    json: { title: event.title, text: event.text, job: event.job, runId: event.runId, state: event.state, summary: event.summary },
  });
};
