import type { Db } from "../db/client.ts";
import { insertAuditEvent } from "../db/repo.ts";

/**
 * The complete event vocabulary. Nothing outside this list is a valid event.
 *
 * Typing the parameter as this union is the point: a typo like
 * `action.exectued` becomes a compile error rather than a silently broken
 * trail that nobody notices until it is on a projector.
 */
export const AUDIT_EVENTS = [
  "action.requested",
  "policy.evaluated",
  /**
   * A model, not a person, judged this action. Recorded whenever the policy
   * returned `classify`, including when the classifier failed and the action
   * was sent to a human as a result.
   *
   * Its own event rather than a field on `policy.evaluated`, so that reading
   * the trail can never leave someone with the impression a person decided.
   */
  "action.classified",
  "action.denied",
  "action.pending_approval",
  "approval.sent",
  "approval.granted",
  "approval.denied",
  "approval.expired",
  "action.executing",
  "action.executed",
  "action.failed",
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/** Events that end an action. Used by the completeness check. */
export const TERMINAL_EVENTS = [
  "action.denied",
  "action.executed",
  "action.failed",
  "approval.denied",
  "approval.expired",
] as const;

/** Key names whose values never belong in an audit record. */
const SECRET_KEY = /secret|key|token|password|authorization/i;

const REDACTED = "[redacted]";

/** `data` is JSON in a text column; a chatty adapter must not be able to bloat the table. */
export const MAX_DATA_BYTES = 4_096;

const MAX_DEPTH = 8;

/**
 * Strips secret-looking keys before serialisation.
 *
 * Runs at **write** time, not read time. Redacting on read would leave the
 * secret sitting in the database file you might hand to someone.
 *
 * This is a denylist, and denylists leak. It catches known key names; it will
 * not catch a secret pasted into a free-text `description`. The real defence is
 * not putting secrets in `data` at all — this is the backstop, not the plan.
 *
 * Note it also catches innocent names containing "key", `idempotencyKey` among
 * them. Losing one of those from a trail is a cosmetic problem; the reverse
 * mistake is not.
 */
export function redact(data: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(value, depth + 1);
  }
  return out;
}

function serialise(data: unknown): string | null {
  if (data === undefined) return null;

  let json: string;
  try {
    json = JSON.stringify(redact(data)) ?? "null";
  } catch {
    // A cycle or a BigInt. Losing the detail beats losing the event.
    return JSON.stringify({ error: "audit data could not be serialised" });
  }

  if (Buffer.byteLength(json, "utf8") > MAX_DATA_BYTES) {
    return JSON.stringify({
      truncated: true,
      bytes: Buffer.byteLength(json, "utf8"),
      preview: json.slice(0, 512),
    });
  }
  return json;
}

/**
 * The only writer of `audit_events`. Append-only: no UPDATE, no DELETE. If a
 * record turns out to be wrong, append a correcting event.
 *
 * Never throws. A failed audit write must not unwind a payment that already
 * moved money — losing the record is bad, reversing a real transaction over a
 * logging error is worse. The failure is logged loudly instead.
 */
export function appendAudit(
  db: Db,
  e: { actionId?: string; projectId: string; event: AuditEvent; data?: unknown },
): void {
  try {
    insertAuditEvent(db, {
      actionId: e.actionId ?? null,
      projectId: e.projectId,
      event: e.event,
      data: serialise(e.data),
    });
  } catch (err) {
    console.error(
      `[adeia] AUDIT WRITE FAILED for ${e.event}` +
        (e.actionId ? ` on ${e.actionId}` : "") +
        " — the action proceeded but is not fully recorded.",
      err,
    );
  }
}
