/** Typed errors thrown by engines and core. Only boundaries catch and log them. */

export class HarvestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Credentials rejected. Never retried. */
export class AuthError extends HarvestError {}

/** Pinned SFTP host key no longer matches. Never retried, never auto-accepted. */
export class HostKeyChanged extends HarvestError {}

/** Network hiccup, timeout, dropped connection, server connection cap. Retried with backoff. */
export class TransientNetwork extends HarvestError {}

/** Anything else that retrying will not fix (missing path, permission denied, bad config). */
export class PermanentError extends HarvestError {}

/** The remote file changed (size or mtime) since the partial download was created. */
export class RemoteChanged extends HarvestError {}

export function isRetryable(err: unknown): boolean {
  return err instanceof TransientNetwork;
}
