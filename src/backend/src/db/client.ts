import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function createDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  // WAL is a file-level mode; an in-memory database has no file to journal.
  if (path !== ":memory:") sqlite.pragma("journal_mode = WAL");
  return drizzle(sqlite, { schema }) as Db;
}

/** ESM has no __dirname — the migrations folder is resolved off import.meta.url. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function migrate(db: Db): void {
  drizzleMigrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

export function closeDb(db: Db): void {
  db.$client.close();
}
