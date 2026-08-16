import { fileURLToPath } from "node:url";
import { generateApiKey, hashApiKey } from "../src/backend/src/auth/apiKey.ts";
import { createDb, migrate } from "../src/backend/src/db/client.ts";
import { insertPolicy, insertProject } from "../src/backend/src/db/repo.ts";
import { env } from "../src/backend/src/env.ts";

/**
 * The demo policy. These four numbers are load-bearing for the Phase 7 script:
 *
 *   $25  invoice  → under the $50 per-action limit  → auto-executes
 *   $500 invoice  → over the per-action limit,
 *                   under the $1,000 hard max,
 *                   under the $2,000 daily cap      → pauses for approval
 *
 * The daily cap must stay above the largest payment in the demo. Deny beats
 * require_approval, so a cap below $500 would deny the second invoice outright
 * and the approval flow — the entire point of the demo — would never fire.
 * Change one of these and re-check the other three.
 */
export const DEMO_POLICY = {
  actionType: "payment",
  maxAmountCents: 5_000, // $50   → above this, ask a human
  hardMaxAmountCents: 100_000, // $1,000 → above this, refuse outright
  dailyCapCents: 200_000, // $2,000 → per project, per currency, per UTC day
  allowedRecipients: null, // any recipient
  requiresApproval: false,
} as const;

/**
 * The http policy: read freely, ask before changing anything.
 *
 * `allowedHosts` is the whole defence for this action type, so it is a short
 * explicit list rather than anything permissive. api.github.com is here
 * because it answers unauthenticated GETs, which makes the read path testable
 * by anyone in one command; api.cloudflare.com because managing DNS is the
 * case this was built for.
 *
 * Methods split the way consequences do. GET and HEAD change nothing, so they
 * run. Everything that writes stops for a person — and a method nobody
 * classified is treated as a write by the engine, so a new verb is safe by
 * default rather than by remembering to list it.
 */
export const DEMO_HTTP_POLICY = {
  actionType: "http",
  requiresApproval: false,
  config: {
    allowedHosts: ["api.github.com", "api.cloudflare.com"],
    approvalMethods: ["POST", "PUT", "PATCH", "DELETE"],
    deniedMethods: [],
    // Bounds a runaway loop. There is no amount to cap, so the budget is
    // attempts.
    maxCallsPerDay: 100,
  },
} as const;

function main(): void {
  const name = process.argv[2] ?? "demo";

  const db = createDb(env.ADEIA_DB_PATH);
  migrate(db);

  const apiKey = generateApiKey();
  const project = insertProject(db, { name, apiKeyHash: hashApiKey(apiKey) });
  const policy = insertPolicy(db, { projectId: project.id, ...DEMO_POLICY });
  const httpPolicy = insertPolicy(db, {
    projectId: project.id,
    actionType: DEMO_HTTP_POLICY.actionType,
    requiresApproval: DEMO_HTTP_POLICY.requiresApproval,
    config: { ...DEMO_HTTP_POLICY.config },
  });

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  console.log(`\n  project   ${project.id}  (${project.name})`);
  console.log(`  database  ${env.ADEIA_DB_PATH}`);
  console.log(`\n  policy    ${policy.id}  type=${policy.actionType}`);
  console.log(`    per-action limit   ${usd(DEMO_POLICY.maxAmountCents)}   above this → approval`);
  console.log(`    hard maximum       ${usd(DEMO_POLICY.hardMaxAmountCents)}   above this → denied`);
  console.log(`    daily cap          ${usd(DEMO_POLICY.dailyCapCents)}   per currency, UTC day`);
  console.log(`    allowed recipients any`);

  console.log(`\n  policy    ${httpPolicy.id}  type=${httpPolicy.actionType}`);
  console.log(`    allowed hosts      ${DEMO_HTTP_POLICY.config.allowedHosts.join(", ")}`);
  console.log(`    reads              GET, HEAD → run immediately`);
  console.log(
    `    writes             ${DEMO_HTTP_POLICY.config.approvalMethods.join(", ")} → ask a human`,
  );
  console.log(`    every other host   denied`);
  console.log(`    daily call cap     ${DEMO_HTTP_POLICY.config.maxCallsPerDay}`);

  console.log(`\n  API key — copy it now, it is not stored and will not be shown again:\n`);
  console.log(`    ${apiKey}\n`);
  console.log(`    export ADEIA_API_KEY=${apiKey}`);
  console.log(`    export ADEIA_URL=http://localhost:${env.PORT}\n`);
}

// Guarded so DEMO_POLICY can be imported (by the docs generator, by tests)
// without seeding a database as a side effect of the import.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
