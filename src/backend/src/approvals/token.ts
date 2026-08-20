import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client.ts";
import {
  getApprovalByTokenHash,
  insertApproval,
  markApprovalRowDecided,
  type ApprovalRow,
} from "../db/repo.ts";
import { env } from "../env.ts";

/**
 * Approval tokens are bearer credentials: whoever holds one can release a
 * payment. They are treated accordingly.
 *
 * - 32 bytes of CSPRNG output, base64url encoded.
 * - Only `sha256(token)` is ever stored. A leaked `approvals` table must not be
 *   a set of live approve buttons.
 * - Single use, enforced at decision time rather than render time — both a
 *   double-clicked button and a browser POST-resubmit reach the server twice.
 * - Expiring, so an ignored request does not stay live indefinitely.
 */

const TOKEN_BYTES = 32;

const digest = (token: string): Buffer => createHash("sha256").update(token).digest();

export const hashApprovalToken = (token: string): string => digest(token).toString("hex");

export class ApprovalTokenError extends Error {
  readonly reason: "unknown" | "used" | "expired";
  readonly actionId: string | null;

  constructor(reason: "unknown" | "used" | "expired", message: string, actionId: string | null) {
    super(message);
    this.name = "ApprovalTokenError";
    this.reason = reason;
    this.actionId = actionId;
  }
}

export interface MintedApproval {
  /** Plaintext. Returned once, to the sender only, and never stored or logged. */
  token: string;
  approvalId: string;
  expiresAt: string;
}

export async function mintApprovalToken(
  db: Db,
  actionId: string,
  ttlMs: number = env.APPROVAL_TOKEN_TTL_MS,
): Promise<MintedApproval> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const row = await insertApproval(db, {
    actionId,
    tokenHash: hashApprovalToken(token),
    expiresAt,
  });

  return { token, approvalId: row.id, expiresAt };
}

/**
 * Resolves a token to its approval row, or throws.
 *
 * Deliberately does **not** mutate anything, including on expiry. Both `GET`
 * and `POST /approvals/:token` call this, and a GET that writes is the failure
 * mode this entire phase is built to avoid. The caller decides what to do with
 * an `expired` result.
 */
export async function verifyApprovalToken(db: Db, token: string): Promise<ApprovalRow> {
  const presented = digest(token);
  const row = await getApprovalByTokenHash(db, presented.toString("hex"));
  if (!row) throw new ApprovalTokenError("unknown", "this approval link is not valid", null);

  // The lookup already matched on the hash; this re-confirms it without a
  // short-circuiting comparison on a secret-derived value.
  const stored = Buffer.from(row.tokenHash, "hex");
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
    throw new ApprovalTokenError("unknown", "this approval link is not valid", null);
  }

  if (row.decidedAt !== null) {
    throw new ApprovalTokenError(
      "used",
      `this request has already been ${row.decision === "approve" ? "approved" : "denied"}`,
      row.actionId,
    );
  }

  if (Date.parse(row.expiresAt) <= Date.now()) {
    throw new ApprovalTokenError("expired", "this approval link has expired", row.actionId);
  }

  return row;
}

/**
 * Spends the token. Returns the row on success, or null if someone else got
 * there first — the update is conditional on `decided_at` still being null, so
 * two simultaneous clicks cannot both succeed.
 *
 * This is the first of two independent guards against double execution. The
 * second is `executeApproved`'s check that the action's status is exactly
 * `approved`.
 */
export async function markApprovalDecided(
  db: Db,
  token: string,
  decision: "approve" | "deny",
  by: string,
): Promise<ApprovalRow | null> {
  const row = await verifyApprovalToken(db, token);
  return await markApprovalRowDecided(db, row.id, decision, by);
}
