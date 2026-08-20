import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as libsqlMigrate } from "drizzle-orm/libsql/migrator";
import { createDb, migrate as fileMigrate } from "../src/backend/src/db/client.node.ts";
import { requireDatabaseConfig } from "../src/backend/src/env.ts";

/**
 * Applies pending migrations, wherever the database happens to be.
 *
 * This exists because the hosted database has no filesystem to read
 * `src/backend/drizzle` from at runtime, and because migrating from inside a
 * request handler would have every cold start racing every other cold start to
 * alter the same tables. So it is a deploy step, run once, deliberately:
 *
 *   npm run db:migrate
 *
 * It reads the same environment the server does, so it targets Turso when
 * TURSO_DATABASE_URL is set and the local file otherwise — there is no second
 * place to configure, and therefore no way to migrate one database while the
 * server talks to another.
 */

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../src/backend/drizzle", import.meta.url),
);

async function main(): Promise<void> {
  const database = requireDatabaseConfig();

  if (database.kind === "file") {
    const db = createDb(database.path);
    fileMigrate(db);
    console.log(`[adeia] migrated ${database.path}`);
    return;
  }

  const client = createClient(
    database.authToken ? { url: database.url, authToken: database.authToken } : { url: database.url },
  );
  await libsqlMigrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  // The host, never the token. A `file:` URL has no host, so it names the file
  // instead — "migrated turso " with nothing after it says nothing at all.
  const target = new URL(database.url);
  console.log(`[adeia] migrated ${target.host || `libsql ${target.pathname}`}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
