import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypting the secret-looking parts of an action's params.
 *
 * An http action carries the credential it needs in `params.headers`. That has
 * to survive until execution — an over-limit action is stored now and run only
 * after a person approves it, possibly hours later — so redacting on write, the
 * way the audit trail does, would leave nothing to authenticate with.
 *
 * So it is encrypted rather than removed. Only the values under secret-looking
 * keys are touched; the method, the URL and the body stay readable, because the
 * approval page has to show a person what they are approving and a page that
 * cannot say where a request is going is worthless.
 *
 * AES-256-GCM: authenticated, so a value tampered with in the database fails to
 * open rather than decrypting to something else. A fresh IV per value, because
 * reusing one under the same key in GCM is the mistake that breaks it entirely.
 */

/** Key names whose values are encrypted. Deliberately the audit denylist. */
const SECRET_KEY = /secret|key|token|password|authorization|credential|cookie/i;

const MAGIC = "__adeia_enc";
const MAX_DEPTH = 8;

interface Envelope {
  [MAGIC]: 1;
  iv: string;
  tag: string;
  ct: string;
}

function isEnvelope(v: unknown): v is Envelope {
  return typeof v === "object" && v !== null && (v as Record<string, unknown>)[MAGIC] === 1;
}

/**
 * The key, as 32 bytes.
 *
 * Hex or base64, both 32 bytes decoded. Anything else is refused rather than
 * padded or hashed into the right length: a key that is silently derived from a
 * short string is a key whose strength nobody can state.
 */
export function parseKey(raw: string): Buffer {
  const hex = /^[0-9a-f]{64}$/i.test(raw.trim());
  const key = Buffer.from(raw.trim(), hex ? "hex" : "base64");
  if (key.length !== 32) {
    throw new Error(
      `ADEIA_PARAMS_KEY must decode to 32 bytes, got ${key.length}. ` +
        "Generate one with: openssl rand -hex 32",
    );
  }
  return key;
}

function sealValue(key: Buffer, plain: string): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    [MAGIC]: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function openValue(key: Buffer, env: Envelope): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

/** True when anything in here is a value this module would encrypt. */
export function hasSecrets(data: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || data === null || typeof data !== "object") return false;
  if (Array.isArray(data)) return data.some((v) => hasSecrets(v, depth + 1));
  return Object.entries(data as Record<string, unknown>).some(
    ([k, v]) => (SECRET_KEY.test(k) && typeof v === "string") || hasSecrets(v, depth + 1),
  );
}

/**
 * Encrypts secret-looking values. Everything else is returned untouched.
 *
 * Non-string secrets are left alone: a number under a key called `token` is not
 * a credential, and encrypting it would change its type on the way back out.
 */
export function sealParams(key: Buffer, data: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((v) => sealParams(key, v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && typeof v === "string" ? sealValue(key, v) : sealParams(key, v, depth + 1);
  }
  return out;
}

/**
 * Reverses it. Anything that is not an envelope passes through, so params
 * written before this existed still open, and so a deployment can be read by
 * one that has the key and one that does not without either crashing.
 */
export function openParams(key: Buffer, data: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((v) => openParams(key, v, depth + 1));
  if (isEnvelope(data)) return openValue(key, data);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    out[k] = openParams(key, v, depth + 1);
  }
  return out;
}
