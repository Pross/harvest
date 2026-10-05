import { httpRequest } from "../http.js";
import { truncate, type Sender } from "./types.js";

export const sendDiscord: Sender = async (config, event, signal) => {
  await httpRequest({
    url: config["webhookUrl"] ?? "", method: "POST", ...(signal ? { signal } : {}),
    json: { content: truncate(`**${event.title}**\n${event.text}`, 2000), allowed_mentions: { parse: [] } },
  });
};
