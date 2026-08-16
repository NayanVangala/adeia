import { z } from "zod";

/**
 * Outbound HTTP calls, fenced.
 *
 * This is the second action type, and it is far more dangerous than the first.
 * A payment has an amount, so "how bad could this be" is a number you can put a
 * ceiling on. An HTTP call has no equivalent: `DELETE /zones/{id}` and
 * `GET /zones` differ by one word and one of them ends a website.
 *
 * The defences, in the order they apply:
 *
 *   1. This schema — the request must be https, must not name a private or
 *      loopback host, and must be small enough to show a human.
 *   2. The policy — an explicit host allowlist, and a decision per method.
 *      Read is allowed, write asks a person, and anything not listed is denied.
 *   3. The adapter — re-resolves the host at execution time and refuses if it
 *      points anywhere private, which is the check this schema cannot do.
 *
 * The third one matters because DNS can lie. A hostname that resolved to a
 * public address when the policy was written can resolve to 169.254.169.254 by
 * the time the call runs, and that address serves cloud credentials to anything
 * that asks.
 */

export const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods that only read. Everything else can change something. */
export const HTTP_READ_METHODS = ["GET", "HEAD"] as const;

export function isReadMethod(method: string): boolean {
  return (HTTP_READ_METHODS as readonly string[]).includes(method);
}

/**
 * Hostnames that must never be reachable, matched literally.
 *
 * This is a fast reject for the obvious cases, not the real defence — an
 * attacker-chosen hostname can resolve to any of these without saying so. The
 * adapter re-checks after resolution. Both exist because this one produces a
 * clear validation error at request time, where it is cheap to read.
 */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local, and the cloud metadata endpoint
  /^\[?::1\]?$/,
  /^\[?fc00:/i,
  /^\[?fd00:/i,
  /^\[?fe80:/i,
];

export function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

/** Bodies are shown to a human in an approval email, so they stay readable. */
const MAX_BODY_BYTES = 16_384;

export const HttpParamsSchema = z
  .object({
    method: z.enum(HTTP_METHODS),

    /**
     * https only. Plaintext http would put any credential in the headers on
     * the wire, and an approval layer that leaks the token it was protecting
     * is worse than no layer.
     */
    url: z
      .string()
      .url("url must be an absolute URL")
      .max(2048, "url must be under 2048 characters")
      .refine((raw) => {
        try {
          return new URL(raw).protocol === "https:";
        } catch {
          return false;
        }
      }, "url must use https")
      .refine((raw) => {
        try {
          return !isBlockedHost(new URL(raw).hostname);
        } catch {
          return false;
        }
      }, "url must not point at a private, loopback or link-local address"),

    /**
     * Passed through as given. Anything that looks like a credential by key
     * name is redacted before the audit row is written — but that is a
     * denylist over names, so a token in a header called `x-custom` is stored
     * in full. Keep credentials in conventionally named headers.
     */
    headers: z.record(z.string(), z.string()).optional(),

    /** Any JSON value. Serialised size is capped so a human can read it. */
    body: z.unknown().optional(),

    /** Shown to the approver. This is the sentence they actually read. */
    description: z.string().max(500).optional(),
  })
  .strict()
  .refine(
    (params) => {
      if (params.body === undefined) return true;
      try {
        return JSON.stringify(params.body).length <= MAX_BODY_BYTES;
      } catch {
        // Circular or otherwise unserialisable — reject rather than send
        // something the audit log cannot record.
        return false;
      }
    },
    { message: `body must serialise to under ${MAX_BODY_BYTES} bytes`, path: ["body"] },
  );

export type HttpParams = z.infer<typeof HttpParamsSchema>;

/**
 * What a request will do, in words anyone can read.
 *
 * Derived from the method and the URL — never from the agent's own
 * description. That separation is the point: an agent that is confused or
 * compromised will label a DELETE "just reading some data", and the person
 * approving it has no way to check. What Adeia states here comes from the
 * request itself and cannot be talked around. The agent's wording is shown
 * beside it, clearly marked as a claim.
 */
export interface PlainExplanation {
  /** One sentence: the verb, in plain words, and where it lands. */
  headline: string;
  /** What this kind of request does generally. */
  what: string;
  /** Present only when the action cannot be taken back. */
  warning: string | null;
}

const METHOD_MEANING: Record<HttpMethod, { verb: string; what: string; warning: string | null }> = {
  GET: {
    verb: "read information from",
    what: "Reading does not change anything. The website sends information back and nothing there is altered.",
    warning: null,
  },
  HEAD: {
    verb: "check something on",
    what: "This asks whether something exists without downloading it. Nothing is changed.",
    warning: null,
  },
  POST: {
    verb: "create something new on",
    what: "This usually adds something — a new record, a new message, a new payment — or starts a job.",
    warning: "Whatever gets created will really exist afterwards. Adeia cannot take it back.",
  },
  PUT: {
    verb: "replace something on",
    what: "This overwrites an existing thing completely with whatever is in the body below.",
    warning: "The old version is gone once this runs. Adeia cannot restore it.",
  },
  PATCH: {
    verb: "change part of something on",
    what: "This edits an existing thing, changing only the fields in the body below.",
    warning: "The previous values are not kept. Adeia cannot put them back.",
  },
  DELETE: {
    verb: "remove something from",
    what: "This destroys whatever is at that address.",
    warning: "This is usually permanent. Adeia cannot undo it, and the website may not either.",
  },
};

export function explainCall(method: string, url: string): PlainExplanation {
  const host = hostOf(url) ?? url;
  const meaning = METHOD_MEANING[method as HttpMethod];

  if (!meaning) {
    // An unrecognised verb. Say so rather than guessing it is harmless — the
    // policy engine treats these as writes for the same reason.
    return {
      headline: `This will send a ${method} request to ${host}.`,
      what: `Adeia does not recognise ${method}, so it is treated as something that could change data.`,
      warning: "Because it is unrecognised, assume it can change or destroy something.",
    };
  }

  return {
    headline: `This will ${meaning.verb} ${host}.`,
    what: meaning.what,
    warning: meaning.warning,
  };
}

/** `https://api.cloudflare.com/client/v4/zones` -> `api.cloudflare.com` */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * One line naming what a call would do, for an approval email or a log.
 * Never includes headers — that is where the credentials are.
 */
export function describeCall(params: Pick<HttpParams, "method" | "url">): string {
  return `${params.method} ${params.url}`;
}
