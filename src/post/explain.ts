import type { Logger } from "../logger.js";
import { ConfigUnreadableError } from "../store/errors.js";
import { IntegrationHttpError } from "./http.js";

/**
 * The boundary for integration errors: returns a message that is safe to show (never a URL or secret) and logs the real
 * error. Expected delivery failures keep their own text, an unreadable stored config gets `unreadable`, anything else is
 * reported as unexpected (and logged at error level) instead of being mislabeled as a config problem.
 */
export function explainError(err: unknown, logger: Logger, ctx: Record<string, unknown>, unreadable: string): string {
  if (err instanceof IntegrationHttpError) return err.message;
  if (err instanceof ConfigUnreadableError) {
    logger.warn({ ...ctx, err }, "stored integration config could not be read");
    return unreadable;
  }
  logger.error({ ...ctx, err }, "unexpected integration error");
  return "unexpected error (see the log)";
}
