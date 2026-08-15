import { randomUUID } from "node:crypto";
import { isTerminal, type ActionRecord, type ActionRequest } from "@adeia/shared";
import { AdeiaError, AdeiaTimeoutError } from "./errors.ts";

export { AdeiaError, AdeiaTimeoutError };
export type { ActionRecord, ActionRequest };

/**
 * `idempotencyKey` is optional here — the client generates one when omitted.
 *
 * Distributed over the union rather than applied to it. A bare
 * `Omit<ActionRequest, …>` collapses the members into one object with a
 * `"payment" | "http"` type and both params shapes, which would let a payment
 * type be sent with http params and still compile.
 */
type WithOptionalKey<T> = T extends unknown
  ? Omit<T, "idempotencyKey"> & { idempotencyKey?: string }
  : never;

export type ActionRequestInput = WithOptionalKey<ActionRequest>;

export interface AdeiaClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable purely so tests need no live server. */
  fetch?: typeof fetch;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
}

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AdeiaClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: AdeiaClientOptions) {
    if (!opts.apiKey) throw new Error("AdeiaClient requires an apiKey");
    this.#apiKey = opts.apiKey;
    this.#baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  /**
   * Requests an action. Resolves with the decided record whatever the outcome —
   * executed, paused for approval, or refused by policy. Check `status`.
   *
   * There is no automatic retry, deliberately. A blind retry against a payment
   * endpoint is how double charges happen. The idempotency key makes a retry
   * *safe*, but the decision to make one is the caller's.
   */
  async requestAction(req: ActionRequestInput): Promise<ActionRecord> {
    // The spread widens `type` back to the full union, which TypeScript cannot
    // re-narrow on its own. The input was a single valid member and only
    // idempotencyKey is added, so the shape is sound; the assertion says that
    // rather than loosening the parameter type and letting a mismatched
    // type/params pair through at the call site.
    const body = {
      ...req,
      idempotencyKey: req.idempotencyKey ?? randomUUID(),
    } as ActionRequest;
    return this.#request("POST", "/v1/actions", body);
  }

  async getAction(id: string): Promise<ActionRecord> {
    return this.#request("GET", `/v1/actions/${encodeURIComponent(id)}`);
  }

  /**
   * Polls until the action reaches a terminal status — executed, failed,
   * denied, or expired.
   *
   * The default timeout is five minutes: long enough for a human to read an
   * approval email and click through, short enough that an ignored request does
   * not hang an agent forever.
   */
  async waitForAction(id: string, opts: WaitOptions = {}): Promise<ActionRecord> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    const deadline = Date.now() + timeoutMs;

    let action = await this.getAction(id);
    while (!isTerminal(action.status)) {
      if (Date.now() >= deadline) {
        throw new AdeiaTimeoutError(id, action.status, timeoutMs);
      }
      await sleep(pollMs);
      action = await this.getAction(id);
    }
    return action;
  }

  async #request(method: "GET" | "POST", path: string, body?: unknown): Promise<ActionRecord> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const payload: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      const detail = (payload ?? {}) as { error?: string; issues?: unknown[] };
      throw new AdeiaError(`${method} ${path} failed with ${res.status}`, {
        status: res.status,
        code: detail.error ?? "unknown_error",
        ...(detail.issues ? { issues: detail.issues } : {}),
      });
    }

    return payload as ActionRecord;
  }
}
