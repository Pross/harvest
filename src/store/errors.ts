/** Typed refusals from the stores, so the web layer can answer with a friendly message. */
export class HostInUseError extends Error {
  constructor(readonly hostId: number, readonly jobNames: string[]) {
    super(`host ${hostId} is used by ${jobNames.length} job(s): ${jobNames.join(", ")}`);
    this.name = "HostInUseError";
  }
}

export class JobBusyError extends Error {
  constructor(readonly jobId: number) {
    super(`job ${jobId} has a queued or running run`);
    this.name = "JobBusyError";
  }
}

/** A stored secret/config row exists but cannot be decrypted or parsed (typically APP_SECRET changed). */
export class ConfigUnreadableError extends Error {
  constructor(what: string, id: number, cause: unknown) {
    super(`stored ${what} ${id} could not be read`, { cause });
    this.name = "ConfigUnreadableError";
  }
}
