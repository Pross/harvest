import { httpRequest, joinUrl } from "../http.js";
import { truncate, type Sender } from "./types.js";

export const sendPushover: Sender = async (config, event, signal) => {
  const base = config["server"] ?? "https://api.pushover.net";
  await httpRequest({
    url: joinUrl(base, "/1/messages.json"), method: "POST", ...(signal ? { signal } : {}),
    json: { token: config["appToken"], user: config["userKey"], title: truncate(event.title, 250), message: truncate(event.text, 1024) },
  });
};
