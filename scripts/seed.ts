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

function main(): void {
  const name = process.argv[2] ?? "demo";

  const db = createDb(env.ADEIA_DB_PATH);
  migrate(db);

  const apiKey = generateApiKey();
  const project = insertProject(db, { name, apiKeyHash: hashApiKey(apiKey) });
  const policy = insertPolicy(db, { projectId: project.id, ...DEMO_POLICY });

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  console.log(`\n  project   ${project.id}  (${project.name})`);
  console.log(`  database  ${env.ADEIA_DB_PATH}`);
  console.log(`\n  policy    ${policy.id}  type=${policy.actionType}`);
  console.log(`    per-action limit   ${usd(DEMO_POLICY.maxAmountCents)}   above this → approval`);
  console.log(`    hard maximum       ${usd(DEMO_POLICY.hardMaxAmountCents)}   above this → denied`);
  console.log(`    daily cap          ${usd(DEMO_POLICY.dailyCapCents)}   per currency, UTC day`);
  console.log(`    allowed recipients any`);

  console.log(`\n  API key — copy it now, it is not stored and will not be shown again:\n`);
  console.log(`    ${apiKey}\n`);
  console.log(`    export ADEIA_API_KEY=${apiKey}`);
  console.log(`    export ADEIA_URL=http://localhost:${env.PORT}\n`);
}

// Guarded so DEMO_POLICY can be imported (by the docs generator, by tests)
// without seeding a database as a side effect of the import.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
