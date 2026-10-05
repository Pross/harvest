import { z } from "zod";

/** True when the URL carries no `user:pass@` part (credentials in a URL leak into logs and are sent on every request). */
export function noUserinfo(u: string): boolean {
  try {
    const x = new URL(u);
    return x.username === "" && x.password === "";
  } catch {
    return false;
  }
}

/** True when the text parses as a URL that carries credentials (used to avoid echoing them back into a page). */
export function hasUserinfo(u: string): boolean {
  try {
    const x = new URL(u);
    return x.username !== "" || x.password !== "";
  } catch {
    return false;
  }
}

/** A trimmed absolute http(s) URL without userinfo. `what` names the expected form in the error message. */
export const httpUrlSchema = (what = "a full URL such as https://host.example"): z.ZodType<string> =>
  z.string().trim().pipe(z.url({ protocol: /^https?$/, error: `Enter ${what} (http or https only)` }).refine(noUserinfo, "The URL must not contain a username or password"));

/** `scheme://host:port` of a URL, or null when it does not parse. Credentials go to this origin and nowhere else. */
export function originOf(u: string | undefined): string | null {
  try {
    return u ? new URL(u).origin : null;
  } catch {
    return null;
  }
}
