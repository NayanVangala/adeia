import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/client.ts";
import {
  getSessionByTokenHash,
  getUser,
  insertSession,
  revokeSession,
  type UserRow,
} from "../db/repo.ts";

/**
 * Dashboard sessions.
 *
 * A session cookie is a bearer credential exactly like an approval token, and
 * is treated the same way: 32 bytes of CSPRNG output, only `sha256(token)`
 * stored, compared with `timingSafeEqual`. A leaked `sessions` table must not
 * be a set of live logins.
 *
 * Expiry is absolute rather than sliding. A sliding window means a stolen
 * cookie stays valid for as long as the thief keeps using it, which is the
 * opposite of what an expiry is for.
 */

const TOKEN_BYTES = 32;

/** Long enough not to be annoying, short enough that a stale laptop logs out. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const SESSION_COOKIE = "adeia_session";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface MintedSession {
  /** Plaintext. Goes into the cookie and is never stored or logged. */
  token: string;
  sessionId: string;
  expiresAt: string;
}

export function mintSession(db: Db, userId: string, ttlMs = SESSION_TTL_MS): MintedSession {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const row = insertSession(db, { userId, tokenHash: hashSessionToken(token), expiresAt });
  return { token, sessionId: row.id, expiresAt };
}

export interface ResolvedSession {
  user: UserRow;
  sessionId: string;
}

/**
 * Turns a cookie value into a user, or null.
 *
 * Null for every failure — unknown token, revoked, expired, user since
 * deleted. The caller cannot tell these apart, and should not: a login page
 * that distinguishes "no such session" from "expired session" is answering
 * questions for whoever is guessing.
 */
export function resolveSession(db: Db, token: string | undefined): ResolvedSession | null {
  if (!token) return null;

  const presented = hashSessionToken(token);
  const row = getSessionByTokenHash(db, presented);
  if (!row) return null;

  // The lookup above already matched on the hash, so this is belt and braces
  // against a future change that makes the lookup fuzzier.
  const stored = Buffer.from(row.tokenHash, "hex");
  const offered = Buffer.from(presented, "hex");
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) return null;

  if (row.revokedAt !== null) return null;
  if (row.expiresAt <= new Date().toISOString()) return null;

  const user = getUser(db, row.userId);
  if (!user) return null;

  return { user, sessionId: row.id };
}

export function endSession(db: Db, sessionId: string): void {
  revokeSession(db, sessionId);
}
