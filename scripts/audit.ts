import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { createDb, migrate } from "../src/backend/src/db/client.node.ts";
import { getAction, listAudit, type AuditRow } from "../src/backend/src/db/repo.ts";
import { env } from "../src/backend/src/env.ts";

/**
 * Prints one action's complete trail.
 *
 *   npm run audit -- act_abc123
 *
 * This ends up on a projector, so it is formatted for reading at presentation
 * size: fixed-width event column, time only, and no wrapping of the leading
 * columns.
 */

const colour = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (code: string, s: string) => (colour ? `[${code}m${s}[0m` : s);
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);

const STATUS_COLOUR: Record<string, string> = {
  executed: "32",
  failed: "31",
  denied: "31",
  expired: "33",
  pending_approval: "33",
};

const EVENT_COLOUR: Record<string, string> = {
  "action.denied": "31",
  "action.failed": "31",
  "action.executed": "32",
  "approval.granted": "32",
  "approval.denied": "31",
  "approval.expired": "33",
  "action.pending_approval": "33",
  "approval.sent": "33",
};

/**
 * One line per value. Node's default `breakLength` splits objects across lines,
 * which pushes the continuation under the timestamp column and destroys the
 * alignment that makes this readable from the back of a room.
 */
const show = (value: unknown): string =>
  inspect(value, {
    depth: 4,
    breakLength: Infinity,
    compact: true,
    colors: colour,
    maxStringLength: 120,
  });

/** The event column is padded to the longest name so the data lines up. */
const EVENT_WIDTH = "action.pending_approval".length;

function printEvent(row: AuditRow): void {
  const time = row.createdAt.slice(11, 19);
  const name = row.event.padEnd(EVENT_WIDTH);
  const painted = EVENT_COLOUR[row.event] ? paint(EVENT_COLOUR[row.event]!, name) : name;
  const data = row.data === null ? "" : show(JSON.parse(row.data));
  console.log(`${dim(time)}  ${painted}  ${data}`);
}

async function main(): Promise<void> {
  const actionId = process.argv[2];
  if (!actionId) {
    console.error("usage: npm run audit -- <actionId>");
    process.exitCode = 1;
    return;
  }

  const db = createDb(env.ADEIA_DB_PATH);
  migrate(db);

  const action = await getAction(db, actionId);
  if (!action) {
    console.error(`no action ${actionId} in ${env.ADEIA_DB_PATH}`);
    process.exitCode = 1;
    return;
  }

  const status = STATUS_COLOUR[action.status]
    ? paint(STATUS_COLOUR[action.status]!, action.status)
    : action.status;

  console.log();
  console.log(`${bold(action.id)}  ${action.type}  ${status}`);
  console.log(`  ${dim("params")}  ${show(action.params)}`);
  if (action.decisionReason) console.log(`  ${dim("policy")}  ${action.decisionReason}`);
  if (action.result) console.log(`  ${dim("result")}  ${show(action.result)}`);
  if (action.error) console.log(`  ${dim("error ")}  ${action.error}`);
  console.log();

  const events = await listAudit(db, action.id);
  if (events.length === 0) {
    console.log(dim("  (no audit events — this should never happen)"));
  }
  for (const row of events) printEvent(row);
  console.log();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The database is remote now, so main() is async. An unhandled rejection
  // would print a warning and exit 0, which in a seed script reads as success.
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
