import { httpRequest } from "../http.js";
import type { Sender } from "./types.js";

/** Publishes via the JSON API at the server root, so non-ASCII titles never go into HTTP headers. */
export const sendNtfy: Sender = async (config, event, signal) => {
  const base = (config["server"] ?? "https://ntfy.sh").replace(/\/+$/, "");
  const failed = event.state === "failed" || event.state === "partial";
  await httpRequest({
    url: base, method: "POST", ...(signal ? { signal } : {}),
    headers: config["token"] ? { authorization: `Bearer ${config["token"]}` } : {},
    json: { topic: config["topic"], title: event.title, message: event.text, priority: failed ? 4 : 3 },
  });
};
