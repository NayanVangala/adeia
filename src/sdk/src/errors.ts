/**
 * Thrown for any non-2xx response. Carries the HTTP status and the server's
 * machine-readable code so a caller can branch without parsing prose.
 *
 * Note that a policy *denial* is not an error — it comes back as a normal
 * `ActionRecord` with `status: "denied"` and a 200. Only transport and request
 * problems land here.
 */
export class AdeiaError extends Error {
  readonly status: number;
  readonly code: string;
  /** Validation issues, when the server returned any. */
  readonly issues?: unknown[];

  constructor(message: string, opts: { status: number; code: string; issues?: unknown[] }) {
    super(message);
    this.name = "AdeiaError";
    this.status = opts.status;
    this.code = opts.code;
    if (opts.issues) this.issues = opts.issues;
  }
}

/** Thrown when `waitForAction` gives up before the action reaches a terminal status. */
export class AdeiaTimeoutError extends Error {
  readonly actionId: string;
  readonly lastStatus: string;

  constructor(actionId: string, lastStatus: string, timeoutMs: number) {
    super(
      `action ${actionId} was still ${lastStatus} after ${timeoutMs}ms — it may still be waiting on a human`,
    );
    this.name = "AdeiaTimeoutError";
    this.actionId = actionId;
    this.lastStatus = lastStatus;
  }
}
