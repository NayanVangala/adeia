import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpParamsSchema, hostOf, isBlockedHost, type HttpParams } from "@adeia/shared";
import type { Adapter, AdapterContext } from "./types.ts";

/**
 * The outbound HTTP adapter.
 *
 * This is the most dangerous file in the codebase. Everything else decides
 * whether something may happen; this is the part that reaches out and does it,
 * from inside your network, with whatever credentials the caller supplied.
 *
 * Four things it refuses to do, and why each one matters:
 *
 *   1. **It re-resolves the hostname and checks every address it gets back.**
 *      The schema rejects `169.254.169.254` written literally, but DNS decides
 *      what a name means, and a name the policy allowed yesterday can point at
 *      the cloud metadata endpoint today. That endpoint hands out credentials
 *      to anything that asks it.
 *
 *   2. **It never follows a redirect.** A permitted host answering `302
 *      http://169.254.169.254/` would otherwise walk the request straight past
 *      the allowlist that was the whole defence. Redirects come back to the
 *      caller as the response they are.
 *
 *   3. **It never returns the request headers.** That is where the credential
 *      is. The result of this adapter is written to `actions.result` and read
 *      back by anyone with the audit trail.
 *
 *   4. **It gives up.** A timeout and a response cap, so a slow or enormous
 *      reply cannot hold an action open or fill the database.
 *
 * One residual risk, stated rather than hidden: between the check in step 1
 * and the connection itself, the name is resolved a second time by fetch, and
 * a hostile resolver could answer differently. Closing that properly means
 * connecting to the verified address directly and carrying the hostname in the
 * Host header and TLS SNI, which fetch does not expose. The allowlist is the
 * defence that does not depend on timing, which is why it has no null case.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Response headers worth keeping. Everything else is noise or a secret. */
const KEPT_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "location",
  "retry-after",
  "x-request-id",
  "x-ratelimit-remaining",
];

export interface HttpCallResult extends Record<string, unknown> {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
  durationMs: number;
  /** The address actually verified before the request went out. */
  resolvedAddress: string;
}

export class HttpAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HttpAdapterError";
    this.code = code;
  }
}

/**
 * Is this address one nothing should be able to reach from inside a server?
 *
 * Covers loopback, the RFC 1918 ranges, link-local — which includes the
 * metadata endpoint — carrier-grade NAT, and the IPv6 equivalents. Anything
 * unparseable is treated as blocked: an address we cannot classify is not one
 * to connect to.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return true;

  if (version === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  const v6 = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::" || v6 === "::1") return true; // unspecified, loopback
  if (v6.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(v6)) return true; // unique local
  // ::ffff:a.b.c.d — an IPv4 address wearing a v6 costume. Classify the inside.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  return false;
}

/**
 * Resolves the host and refuses if any address it answers with is private.
 *
 * Every address, not just the first. A name that returns one public address
 * and one private one is a rebinding attempt, and taking the first would make
 * whether it worked a matter of resolver ordering.
 */
export async function resolvePublicAddress(hostname: string): Promise<string> {
  if (isBlockedHost(hostname)) {
    throw new HttpAdapterError("blocked_host", `host "${hostname}" is not permitted`);
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (err) {
    throw new HttpAdapterError(
      "dns_failed",
      `could not resolve "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (addresses.length === 0) {
    throw new HttpAdapterError("dns_failed", `"${hostname}" resolved to no addresses`);
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new HttpAdapterError(
        "private_address",
        `"${hostname}" resolves to ${address}, which is private, loopback or link-local`,
      );
    }
  }

  return addresses[0]!.address;
}

export interface HttpAdapterOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Injectable so tests need no network. */
  fetch?: typeof fetch;
}

export function createHttpAdapter(options: HttpAdapterOptions = {}): Adapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    type: "http",
    name: "fetch",

    async execute(rawParams: unknown, ctx: AdapterContext): Promise<HttpCallResult> {
      // Re-validated rather than trusted. These params were stored between the
      // policy decision and now, and https-only is a property worth confirming
      // at the moment of use.
      const params: HttpParams = HttpParamsSchema.parse(rawParams);

      const hostname = hostOf(params.url);
      if (hostname === null) {
        throw new HttpAdapterError("bad_url", `could not parse a host from "${params.url}"`);
      }

      const resolvedAddress = await resolvePublicAddress(hostname);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();

      const headers: Record<string, string> = {
        ...(params.headers ?? {}),
        // The caller's key, so the far end can deduplicate a retry that got
        // past our own unique index.
        "idempotency-key": ctx.idempotencyKey,
      };

      const init: RequestInit = {
        method: params.method,
        headers,
        // Never automatic. A 302 to a private address would otherwise walk
        // straight past the allowlist.
        redirect: "manual",
        signal: controller.signal,
      };

      if (params.body !== undefined) {
        init.body = JSON.stringify(params.body);
        // Only when we are the ones serialising, and only if the caller has
        // not already declared it. Header names are case-insensitive, so the
        // check has to be too — setting a second `Content-Type` that differs
        // in case is how a request ends up with both.
        const declared = Object.keys(headers).some(
          (name) => name.toLowerCase() === "content-type",
        );
        if (!declared) headers["content-type"] = "application/json";
      }

      try {
        const response = await doFetch(params.url, init);

        const raw = await response.text();
        const truncated = raw.length > maxBytes;

        const headers: Record<string, string> = {};
        for (const name of KEPT_RESPONSE_HEADERS) {
          const value = response.headers.get(name);
          if (value !== null) headers[name] = value;
        }

        return {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers,
          body: truncated ? raw.slice(0, maxBytes) : raw,
          bodyTruncated: truncated,
          durationMs: Date.now() - startedAt,
          resolvedAddress,
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new HttpAdapterError("timeout", `no response within ${timeoutMs}ms`);
        }
        throw new HttpAdapterError(
          "request_failed",
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
