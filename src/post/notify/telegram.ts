import { httpRequest, joinUrl } from "../http.js";
import { truncate, type Sender } from "./types.js";

export const sendTelegram: Sender = async (config, event, signal) => {
  const base = config["server"] ?? "https://api.telegram.org";
  await httpRequest({
    url: joinUrl(base, `/bot${encodeURIComponent(config["botToken"] ?? "")}/sendMessage`), method: "POST", ...(signal ? { signal } : {}),
    json: { chat_id: config["chatId"], text: truncate(`${event.title}\n${event.text}`, 4000) },
  });
};
