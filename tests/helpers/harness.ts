import type { Hono } from "hono";
import type { ActionRecord } from "@adeia/shared";
import {
  createFakeAdapter,
  createFakeHttpAdapter,
  type FakeAdapter,
} from "../../src/backend/src/adapters/fake.ts";
import { createRegistry } from "../../src/backend/src/adapters/types.ts";
import type { AppDeps, AppEnv } from "../../src/backend/src/appEnv.ts";
import { mintApprovalToken } from "../../src/backend/src/approvals/token.ts";
import { appendAudit } from "../../src/backend/src/audit/log.ts";
import { generateApiKey, hashApiKey } from "../../src/backend/src/auth/apiKey.ts";
import { createDb, migrate, type Db } from "../../src/backend/src/db/client.ts";
import type { ClassifierInput, Verdict } from "../../src/backend/src/policy/classify.ts";
import {
  getAction,
  insertPolicy,
  insertProject,
  type NewPolicy,
} from "../../src/backend/src/db/repo.ts";
import { createApp } from "../../src/backend/src/server.ts";

export const APPROVER_EMAIL = "approver@example.test";

export interface SentApproval {
  actionId: string;
  /** Plaintext, as the email would have carried it. */
  token: string;
  expiresAt: string;
  action: ActionRecord;
}

/**
 * An in-memory Adeia: migrated database, one project with a real API key, the
 * Phase 1 demo policy, and a fake adapter whose calls are recorded.
 *
 * `approvalCalls` captures what the service passed to `onApprovalNeeded`, which
 * stands in for Phase 5's email sender.
 */
export interface Harness {
  db: Db;
  app: Hono<AppEnv>;
  deps: AppDeps;
  adapter: FakeAdapter;
  /** The http adapter. Only reachable when `httpPolicy` was seeded. */
  httpAdapter: FakeAdapter;
  apiKey: string;
  projectId: string;
  approvalCalls: Array<{ actionId: string; projectId: string }>;
  /** Approval requests the fake transport "delivered", newest last. */
  sentEmails: SentApproval[];
  /** Exactly what the classifier was handed, for asserting on what it never saw. */
  classifierCalls: ClassifierInput[];
  /** A second project, for cross-tenant scoping assertions. */
  other: { apiKey: string; projectId: string };
}

export interface HarnessOptions {
  /** Overrides merged onto the default demo policy. */
  policy?: Partial<NewPolicy> | null;
  /** TTL for tokens minted by the notifier. Negative mints an already-dead one. */
  tokenTtlMs?: number;
  /** Set false to pause actions without minting a token, as Phase 3 did. */
  mintApprovals?: boolean;
  /**
   * The verdict the fake classifier returns, or a function for per-call
   * control. Defaults to `high`, matching the production stub: a test that has
   * not thought about classification gets the cautious answer.
   */
  verdict?: Partial<Verdict> | ((input: ClassifierInput) => Partial<Verdict>);
  /**
   * Seeds an http policy alongside the payment one. Absent means no http
   * policy exists, which the engine denies — the same as production.
   */
  httpPolicy?: Partial<HttpPolicyConfig> | null;
  /** Configures dashboard sign-in. Absent means the deployment has no OAuth app. */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string };
  /** Stands in for GitHub during the OAuth handshake. */
  fetch?: typeof fetch;
}

/** The `config` blob an http policy row carries. */
export interface HttpPolicyConfig {
  allowedHosts: string[];
  approvalMethods: string[];
  classifyMethods: string[];
  deniedMethods: string[];
  maxCallsPerDay: number | null;
}

const DEMO_HTTP_CONFIG: HttpPolicyConfig = {
  allowedHosts: ["api.github.com"],
  approvalMethods: ["DELETE"],
  classifyMethods: ["POST", "PUT", "PATCH"],
  deniedMethods: [],
  maxCallsPerDay: 100,
};

const DEMO_POLICY = {
  actionType: "payment",
  maxAmountCents: 5_000,
  hardMaxAmountCents: 100_000,
  dailyCapCents: 200_000,
  allowedRecipients: null,
  requiresApproval: false,
} satisfies Omit<NewPolicy, "projectId">;

export function createHarness(opts: HarnessOptions = {}): Harness {
  const db = createDb(":memory:");
  migrate(db);

  const apiKey = generateApiKey();
  const project = insertProject(db, { name: "test", apiKeyHash: hashApiKey(apiKey) });

  const otherKey = generateApiKey();
  const otherProject = insertProject(db, { name: "other", apiKeyHash: hashApiKey(otherKey) });

  // `policy: null` seeds no policy at all, which the engine denies outright.
  if (opts.policy !== null) {
    insertPolicy(db, { ...DEMO_POLICY, ...opts.policy, projectId: project.id });
    insertPolicy(db, { ...DEMO_POLICY, ...opts.policy, projectId: otherProject.id });
  }

  // Opt-in, so the many tests that only care about payments keep a database
  // where an http action is denied for want of a policy — which is what a real
  // project that never configured one would see.
  if (opts.httpPolicy !== undefined && opts.httpPolicy !== null) {
    const config = { ...DEMO_HTTP_CONFIG, ...opts.httpPolicy };
    for (const p of [project, otherProject]) {
      insertPolicy(db, {
        projectId: p.id,
        actionType: "http",
        requiresApproval: false,
        config,
      });
    }
  }

  const adapter = createFakeAdapter();
  const httpAdapter = createFakeHttpAdapter();
  const approvalCalls: Array<{ actionId: string; projectId: string }> = [];
  const sentEmails: SentApproval[] = [];
  const classifierCalls: ClassifierInput[] = [];

  const deps: AppDeps = {
    db,
    adapters: createRegistry([adapter, httpAdapter]),
    approverEmail: APPROVER_EMAIL,
    oauth: opts.oauth,
    fetch: opts.fetch,
    classifier: async (input) => {
      classifierCalls.push(input);
      const override = typeof opts.verdict === "function" ? opts.verdict(input) : opts.verdict;
      return {
        risk: "high",
        reason: "fake classifier",
        failed: false,
        model: "fake",
        durationMs: 0,
        ...override,
      };
    },
    onApprovalNeeded: async (actionId, projectId) => {
      approvalCalls.push({ actionId, projectId });
      if (opts.mintApprovals === false) return;

      // Exercises the real token module; only the transport is faked.
      const action = getAction(db, actionId)!;
      const { token, expiresAt } = await mintApprovalToken(db, actionId, opts.tokenTtlMs ?? 60_000);
      sentEmails.push({ actionId, token, expiresAt, action });
      appendAudit(db, {
        actionId,
        projectId,
        event: "approval.sent",
        data: { to: APPROVER_EMAIL, expiresAt },
      });
    },
  };

  return {
    db,
    app: createApp(deps),
    deps,
    adapter,
    httpAdapter,
    apiKey,
    projectId: project.id,
    approvalCalls,
    sentEmails,
    classifierCalls,
    other: { apiKey: otherKey, projectId: otherProject.id },
  };
}

/** A payment request body. Amounts are cents. */
export function paymentRequest(
  amountCents: number,
  opts: { idempotencyKey?: string; recipient?: string; description?: string } = {},
) {
  return {
    type: "payment" as const,
    idempotencyKey: opts.idempotencyKey ?? `key-${amountCents}-${Math.random()}`,
    params: {
      amountCents,
      currency: "usd",
      recipient: opts.recipient ?? "acct_demo",
      ...(opts.description ? { description: opts.description } : {}),
    },
  };
}

/** An http request body. */
export function httpRequest(
  method: string,
  opts: {
    url?: string;
    body?: unknown;
    description?: string;
    idempotencyKey?: string;
  } = {},
) {
  return {
    type: "http" as const,
    idempotencyKey: opts.idempotencyKey ?? `key-${method}-${Math.random()}`,
    params: {
      method,
      url: opts.url ?? "https://api.github.com/repos/x/y/issues",
      ...(opts.body === undefined ? {} : { body: opts.body }),
      ...(opts.description ? { description: opts.description } : {}),
    },
  } as never;
}
