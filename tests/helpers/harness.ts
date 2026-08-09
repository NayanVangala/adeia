import type { Hono } from "hono";
import { createFakeAdapter, type FakeAdapter } from "../../src/backend/src/adapters/fake.ts";
import { createRegistry } from "../../src/backend/src/adapters/types.ts";
import type { RequestDeps } from "../../src/backend/src/actions/service.ts";
import type { AppEnv } from "../../src/backend/src/appEnv.ts";
import { generateApiKey, hashApiKey } from "../../src/backend/src/auth/apiKey.ts";
import { createDb, migrate, type Db } from "../../src/backend/src/db/client.ts";
import { insertPolicy, insertProject, type NewPolicy } from "../../src/backend/src/db/repo.ts";
import { createApp } from "../../src/backend/src/server.ts";

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
  deps: RequestDeps;
  adapter: FakeAdapter;
  apiKey: string;
  projectId: string;
  approvalCalls: Array<{ actionId: string; projectId: string }>;
  /** A second project, for cross-tenant scoping assertions. */
  other: { apiKey: string; projectId: string };
}

export interface HarnessOptions {
  /** Overrides merged onto the default demo policy. */
  policy?: Partial<NewPolicy> | null;
}

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

  const adapter = createFakeAdapter();
  const approvalCalls: Array<{ actionId: string; projectId: string }> = [];

  const deps: RequestDeps = {
    db,
    adapters: createRegistry([adapter]),
    onApprovalNeeded: async (actionId, projectId) => {
      approvalCalls.push({ actionId, projectId });
    },
  };

  return {
    db,
    app: createApp(deps),
    deps,
    adapter,
    apiKey,
    projectId: project.id,
    approvalCalls,
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
