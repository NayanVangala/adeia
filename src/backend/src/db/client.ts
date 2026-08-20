import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.ts";

/**
 * The database, as the rest of the server is allowed to see it.
 *
 * Deliberately not `BetterSQLite3Database` and not `DrizzleD1Database`. Adeia
 * runs on two SQLite drivers now — better-sqlite3 on a file for development
 * and for the test suite, D1 on Cloudflare in production — and they differ in
 * exactly one way that reaches the type system: better-sqlite3 is synchronous
 * and D1 is not.
 *
 * Drizzle already models that difference as a type parameter, so naming both
 * kinds here gives one database type that both drivers satisfy. The cost is
 * that a terminal `.all()` is `T[] | Promise<T[]>` rather than either one, and
 * the price of that is a single `await` — which is correct against both, since
 * awaiting a plain value is the value.
 *
 * That is why every function in `repo.ts` is `async` even though half of the
 * time it is talking to a synchronous driver. One repository, two drivers, no
 * second implementation to keep honest.
 */
export type Db = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

export { schema };
