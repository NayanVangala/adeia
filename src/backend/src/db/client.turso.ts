import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";

/**
 * SQLite over the network, for production.
 *
 * libSQL is a fork of SQLite rather than a different database, which is the
 * whole reason it was chosen. The schema in `schema.ts` is unchanged, the four
 * migrations in `src/backend/drizzle` apply as written, and — the part that
 * actually decided it — the SQL this repository leans on keeps working.
 *
 * That SQL is not incidental. `repo.ts` orders the audit trail by
 * `(created_at, rowid)` because ids are random nanoids and several events land
 * in the same millisecond, so SQLite's insertion-ordered rowid is the only
 * correct tiebreak; the project feed pages on `rowid` for the same reason; and
 * the daily spend total sums `json_extract(params, '$.amountCents')`. Postgres
 * has no rowid and spells the JSON differently, so moving there would have
 * meant re-deriving the append-only ordering guarantee — the highest-stakes
 * logic in the system — rather than porting it.
 *
 * There is no `migrate` here. Applying schema changes from inside a request
 * handler means every cold start racing to alter the same tables; migrations
 * run once, ahead of the deploy, via `npm run db:migrate`.
 */
export function createTursoDb(url: string, authToken?: string): Db {
  /* A `file:` URL is local and takes no credentials; `libsql:`/`https:` is
     Turso and does. Passing an undefined token to a remote database fails at
     the first query rather than at construction, which is a long way from the
     mistake. */
  const client = createClient(authToken ? { url, authToken } : { url });
  return drizzle(client, { schema }) as unknown as Db;
}
