import { fileURLToPath } from "node:url";
import { generateApiKey, hashApiKey } from "../src/backend/src/auth/apiKey.ts";
import { createDb, migrate } from "../src/backend/src/db/client.node.ts";
import { createTursoDb } from "../src/backend/src/db/client.turso.ts";
import { insertPolicy, insertProject } from "../src/backend/src/db/repo.ts";
import { env, requireDatabaseConfig } from "../src/backend/src/env.ts";
import type { Db } from "../src/backend/src/db/client.node.ts";

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
 * The http policy: read freely, judge most writes, always ask before deleting.
 *
 * `allowedHosts` is the whole defence for this action type, so it is a short
 * explicit list rather than anything permissive. api.github.com is here
 * because it answers unauthenticated GETs, which makes the read path testable
 * by anyone in one command; api.cloudflare.com because managing DNS is the
 * case this was built for.
 *
 * Methods split three ways, by how much a mistake costs.
 *
 * GET and HEAD change nothing, so they run. POST, PUT and PATCH go to the risk
 * classifier: creating an issue and repointing a DNS record are both writes,
 * and asking about them identically is what buried the approvals that mattered.
 * DELETE stays with a person whatever the classifier would have said — it is
 * the one verb whose mistakes cannot be inspected afterwards, because the thing
 * you would inspect is gone.
 *
 * A method in neither list is still treated as a write by the engine, so a new
 * verb is safe by default rather than by remembering to list it.
 */
export const DEMO_HTTP_POLICY = {
  actionType: "http",
  requiresApproval: false,
  config: {
    allowedHosts: ["api.github.com", "api.cloudflare.com"],
    approvalMethods: ["DELETE"],
    classifyMethods: ["POST", "PUT", "PATCH"],
    deniedMethods: [],
    // Bounds a runaway loop. There is no amount to cap, so the budget is
    // attempts. It also bounds classifier spend: no action, no classification.
    maxCallsPerDay: 100,
  },
} as const;

async function main(): Promise<void> {
  const name = process.argv[2] ?? "demo";

  /* The same resolution the server and `npm run db:migrate` use. Naming
     ADEIA_DB_PATH directly meant a deployment could be seeded and still start
     empty: the project and the API key went to a local file the serverless
     function has no way to open, and the only symptom was an API key that
     authenticated nowhere.

     Migrations run for a file only. A remote database is migrated by
     `npm run db:migrate` as its own deploy step, and doing it here as well
     would put two paths in a race to alter the same tables. */
  const database = requireDatabaseConfig();
  const db: Db =
    database.kind === "file"
      ? createDb(database.path)
      : createTursoDb(database.url, database.authToken);
  if (database.kind === "file") migrate(db);

  const apiKey = generateApiKey();
  const project = await insertProject(db, { name, apiKeyHash: hashApiKey(apiKey) });
  const policy = await insertPolicy(db, { projectId: project.id, ...DEMO_POLICY });
  const httpPolicy = await insertPolicy(db, {
    projectId: project.id,
    actionType: DEMO_HTTP_POLICY.actionType,
    requiresApproval: DEMO_HTTP_POLICY.requiresApproval,
    config: { ...DEMO_HTTP_POLICY.config },
  });

  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  console.log(`\n  project   ${project.id}  (${project.name})`);
  console.log(
    `  database  ${database.kind === "file" ? database.path : new URL(database.url).host}`,
  );
  console.log(`\n  policy    ${policy.id}  type=${policy.actionType}`);
  console.log(`    per-action limit   ${usd(DEMO_POLICY.maxAmountCents)}   above this → approval`);
  console.log(`    hard maximum       ${usd(DEMO_POLICY.hardMaxAmountCents)}   above this → denied`);
  console.log(`    daily cap          ${usd(DEMO_POLICY.dailyCapCents)}   per currency, UTC day`);
  console.log(`    allowed recipients any`);

  console.log(`\n  policy    ${httpPolicy.id}  type=${httpPolicy.actionType}`);
  console.log(`    allowed hosts      ${DEMO_HTTP_POLICY.config.allowedHosts.join(", ")}`);
  console.log(`    reads              GET, HEAD → run immediately`);
  console.log(
    `    judged             ${DEMO_HTTP_POLICY.config.classifyMethods.join(", ")} → risk classifier decides`,
  );
  console.log(
    `    always ask         ${DEMO_HTTP_POLICY.config.approvalMethods.join(", ")} → a human, whatever the classifier says`,
  );
  console.log(`    every other host   denied`);
  console.log(`    daily call cap     ${DEMO_HTTP_POLICY.config.maxCallsPerDay}`);

  console.log(`\n  API key — copy it now, it is not stored and will not be shown again:\n`);
  console.log(`    ${apiKey}\n`);
  console.log(`    export ADEIA_API_KEY=${apiKey}`);
  // A seeded deployment is reached at its public URL; localhost is right only
  // when the database is the local file too.
  console.log(
    `    export ADEIA_URL=${database.kind === "file" ? `http://localhost:${env.PORT}` : (env.PUBLIC_BASE_URL ?? "https://your-deployment")}\n`,
  );
}

// Guarded so DEMO_POLICY can be imported (by the docs generator, by tests)
// without seeding a database as a side effect of the import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The database is remote now, so main() is async. An unhandled rejection
  // would print a warning and exit 0, which in a seed script reads as success.
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
