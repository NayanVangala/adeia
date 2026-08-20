import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";

/**
 * SQLite on a file, for development, for `scripts/`, and for the tests.
 *
 * This module imports a native addon and Node's own `url` and therefore cannot
 * be bundled for Cloudflare. Keeping it in its own file is what lets the rest
 * of the server stay portable: nothing under `routes/`, `actions/` or `auth/`
 * imports a driver, only the `Db` type, so the Worker build never pulls
 * better-sqlite3 into its dependency graph.
 *
 * The production counterpart is `client.d1.ts`.
 */
/**
 * A `Db` that also admits the driver underneath it.
 *
 * The portable `Db` deliberately hides `$client`, because on Cloudflare there
 * is no local handle to hand out. The tests genuinely need one: several of them
 * set up state or read it back with raw SQL that the repository has no business
 * exposing — backdating a row's `created_at` to test the daily cap, for one,
 * which the repo cannot do because writing history is not something production
 * code should be able to ask for.
 *
 * So the escape hatch is named, and it is only reachable from the driver that
 * actually has one.
 */
export type NodeDb = Db & { $client: Database.Database };

export function createDb(path: string): NodeDb {
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  // WAL is a file-level mode; an in-memory database has no file to journal.
  if (path !== ":memory:") sqlite.pragma("journal_mode = WAL");
  return drizzle(sqlite, { schema }) as unknown as NodeDb;
}

/** ESM has no __dirname — the migrations folder is resolved off import.meta.url. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Applies pending migrations in-process.
 *
 * Development and the test suite only. In production the same SQL in
 * `src/backend/drizzle` is applied ahead of the deploy rather than on a
 * request: migrating from inside a serverless handler means every cold start
 * racing to alter the same tables. Same files, same order — a different thing
 * runs them.
 */
export function migrate(db: Db): void {
  drizzleMigrate(db as never, { migrationsFolder: MIGRATIONS_FOLDER });
}

export function closeDb(db: NodeDb): void {
  db.$client.close();
}

export type { Db };
