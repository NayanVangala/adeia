import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/backend/src/db/client.ts";
import { createTursoDb } from "../../../src/backend/src/db/client.turso.ts";
import {
  classifierVerdictsFor,
  consumeOauthState,
  countActionsByStatus,
  getPolicy,
  getVisitCounts,
  insertAction,
  insertAuditEvent,
  insertOauthState,
  insertPolicy,
  insertProject,
  listActionsByProject,
  listAudit,
  listProjectAudit,
  recordVisit,
  sumSpentTodayCents,
  toPolicy,
  updateActionStatus,
  upsertUserFromGithub,
} from "../../../src/backend/src/db/repo.ts";

/**
 * The repository, against libSQL.
 *
 * Every other test in this suite runs on better-sqlite3, because it is fast and
 * needs no network. Production does not: it runs on Turso, which is libSQL
 * reached over HTTP. Those are two different drivers, and the portable `Db`
 * type is the only thing asserting they behave alike — a type cannot check
 * that `rowid` still means what the audit trail needs it to mean.
 *
 * So this file exercises the parts of `repo.ts` that lean on SQLite itself
 * rather than on drizzle's query builder, which are exactly the parts that
 * would have had to be rewritten for Postgres and are therefore the parts worth
 * proving:
 *
 *   json_extract        the daily spend total
 *   rowid ordering      the audit trail's total order
 *   rowid keyset        the project feed's pagination
 *   INSERT OR IGNORE    the visit counter's deduplication
 *   conditional UPDATE  single-use OAuth states
 *
 * libSQL is used in-memory here, so this costs a few milliseconds and no
 * account. It is the same driver the deployed server loads.
 */

const MIGRATIONS = fileURLToPath(new URL("../../../src/backend/drizzle", import.meta.url));

let db: Db;
let projectId: string;
let dir: string;

/* A file rather than `:memory:`: libSQL gives every in-memory client its own
   private database, so the migrator and the server would end up looking at two
   different empty ones. A file is also what Turso is — one database, several
   connections — which is the thing being tested. */
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "adeia-libsql-"));
  const url = `file:${join(dir, "test.db")}`;
  await migrate(drizzle(createClient({ url })), { migrationsFolder: MIGRATIONS });
  db = createTursoDb(url);
  projectId = (await insertProject(db, { name: "libsql", apiKeyHash: "hash-a" })).id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const payment = (amountCents: number, currency = "usd") => ({
  amountCents,
  currency,
  recipient: "acct_demo",
});

describe("the driver production actually runs on", () => {
  it("round-trips a policy", async () => {
    await insertPolicy(db, {
      projectId,
      actionType: "payment",
      maxAmountCents: 5000,
      hardMaxAmountCents: 100_000,
    });

    const policy = toPolicy((await getPolicy(db, projectId, "payment"))!);
    expect(policy.actionType).toBe("payment");
    expect(policy.actionType === "payment" && policy.maxAmountCents).toBe(5000);
  });

  it("sums today's spend with json_extract, per currency and executed only", async () => {
    for (const [cents, currency, status] of [
      [1000, "usd", "executed"],
      [9999, "usd", "denied"],
      [500, "eur", "executed"],
    ] as const) {
      await insertAction(db, {
        projectId,
        type: "payment",
        params: payment(cents, currency),
        status,
        idempotencyKey: `k-${cents}-${currency}`,
      });
    }

    expect(await sumSpentTodayCents(db, projectId, "usd")).toBe(1000);
    expect(await sumSpentTodayCents(db, projectId, "eur")).toBe(500);
  });

  /**
   * The one that decided the database. Ids are random nanoids and several
   * events land inside the same millisecond, so insertion order can only come
   * from rowid.
   */
  it("keeps the audit trail in insertion order, not id order", async () => {
    const action = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(1),
      status: "pending_policy",
      idempotencyKey: "trail",
    });

    const sequence = [
      "action.requested",
      "policy.evaluated",
      "action.executing",
      "action.executed",
    ];
    for (const event of sequence) {
      await insertAuditEvent(db, { actionId: action.id, projectId, event });
    }

    expect((await listAudit(db, action.id)).map((row) => row.event)).toEqual(sequence);
  });

  it("pages the project feed on rowid without repeating a row", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAuditEvent(db, { projectId, event: "policy.evaluated", data: String(i) });
    }

    const first = await listProjectAudit(db, projectId, { limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listProjectAudit(db, projectId, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    const ids = new Set(first.events.map((e) => e.id));
    expect(second.events.some((e) => ids.has(e.id))).toBe(false);
  });

  /**
   * A real driver difference, worth pinning down rather than papering over.
   *
   * better-sqlite3 throws with SQLite's own message on it, so the sibling test
   * in repo.test.ts matches `/UNIQUE constraint failed/`. libSQL does not: it
   * wraps the failure in a DrizzleQueryError whose message is the SQL that was
   * attempted, and the constraint only appears further down the `cause` chain.
   *
   * Nothing in the server reads either message — idempotency is a read before
   * the insert, and this constraint is the backstop for a genuine race — so
   * this is a difference to know about rather than a bug to fix. It is asserted
   * here so that if a future change *does* start matching on it, this is what
   * says the two drivers disagree.
   */
  it("surfaces a unique-constraint violation as a rejection", async () => {
    await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(1),
      status: "pending_policy",
      idempotencyKey: "dupe",
    });

    const failure = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2),
      status: "pending_policy",
      idempotencyKey: "dupe",
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(Error);

    const chain: Array<{ code?: unknown; message?: unknown }> = [];
    for (let node: unknown = failure; node instanceof Error; node = node.cause) {
      chain.push(node as { code?: unknown; message?: unknown });
    }

    expect(chain.some((e) => e.code === "SQLITE_CONSTRAINT")).toBe(true);
    expect(chain.some((e) => /UNIQUE constraint failed/i.test(String(e.message)))).toBe(true);
  });

  it("counts a repeat visitor once, via the unique index", async () => {
    await recordVisit(db, "visitor-1");
    await recordVisit(db, "visitor-1");

    expect((await getVisitCounts(db)).total).toBe(1);
  });

  it("returns the updated row from an UPDATE", async () => {
    const action = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(1),
      status: "pending_policy",
      idempotencyKey: "k",
    });

    const executed = await updateActionStatus(db, action.id, { status: "executed" });
    expect(executed.status).toBe("executed");
  });

  /** The conditional update has to return nothing the second time, not throw. */
  it("spends an OAuth state exactly once", async () => {
    await insertOauthState(db, {
      stateHash: "s1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(await consumeOauthState(db, "s1")).not.toBeNull();
    expect(await consumeOauthState(db, "s1")).toBeNull();
  });

  it("matches a returning user on the GitHub id rather than the login", async () => {
    const first = await upsertUserFromGithub(db, { githubId: "1", login: "original" });
    const second = await upsertUserFromGithub(db, { githubId: "1", login: "renamed" });

    expect(second.id).toBe(first.id);
    expect(second.login).toBe("renamed");
  });

  it("reads back the dashboard's aggregates", async () => {
    await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(1),
      status: "executed",
      idempotencyKey: "k",
    });

    expect(await countActionsByStatus(db, projectId, "executed")).toBe(1);
    expect(await listActionsByProject(db, projectId)).toHaveLength(1);
    expect(await classifierVerdictsFor(db, [])).toBeInstanceOf(Map);
  });
});
