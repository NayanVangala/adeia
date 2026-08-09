import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../appEnv.ts";
import { getProjectByKeyHash } from "../db/repo.ts";

export const API_KEY_PREFIX = "adeia_sk_";

/** 32 bytes of CSPRNG output. Shown to the operator exactly once, at seed time. */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** sha256 hex. Only this ever reaches the database. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

/**
 * Authenticates the caller and pins the request to one project.
 *
 * The stored hash is confirmed with `timingSafeEqual` rather than `===`: a
 * short-circuiting comparison on a secret-derived value leaks how many leading
 * bytes a guess got right.
 */
export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const presented = hashApiKey(token);
  const project = getProjectByKeyHash(c.get("deps").db, presented);
  if (!project) return c.json({ error: "unauthorized" }, 401);

  const stored = Buffer.from(project.apiKeyHash, "hex");
  const offered = Buffer.from(presented, "hex");
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("projectId", project.id);
  await next();
};
