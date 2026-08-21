import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql/web";
import type { Db } from "./client.ts";
import * as schema from "./schema.ts";

/**
 * The same database as `client.turso.ts`, reached without a native module.
 *
 * `@libsql/client` resolves, at import time, to a build that can also open a
 * local file — and opening a local file means a compiled SQLite binding,
 * `@libsql/<platform>`. That binding is chosen for the machine that ran
 * `npm install`. Install on a Mac and deploy the result to Linux and the
 * function throws on its first request:
 *
 *   Cannot find module '@libsql/linux-arm64-gnu'
 *
 * A serverless function has no local file to open, so the capability it is
 * paying for is one it cannot use. `@libsql/client/web` is the same client
 * over `fetch` with no native dependency, which makes the deployment
 * indifferent to the architecture it was built on.
 *
 * Both imports have to be the web ones. `drizzle-orm/libsql` re-exports the
 * driver for every transport, so importing the root pulls `@libsql/client`
 * root back in and the native binding arrives through the back door — the
 * client import alone changes nothing.
 *
 * The trade is that `file:` URLs are refused here rather than silently
 * downgraded — see the check below. `client.turso.ts` keeps the full client
 * for `server.node.ts` and the scripts, which do have a disk.
 */
export function createTursoWebDb(url: string, authToken?: string): Db {
  /* Refused explicitly. Left to the client this surfaces as a fetch failure
     against a URL with no host, which reads like a network problem and sends
     you looking at Turso rather than at the variable you set. */
  if (url.startsWith("file:")) {
    throw new Error(
      `TURSO_DATABASE_URL is a file: URL (${url}), and this build has no filesystem.\n` +
        "  A serverless function's disk is discarded between invocations, so a\n" +
        "  local database here loses every approval token it hands out.\n" +
        "  Point it at a libsql:// URL, or run the Node server instead: npm run dev",
    );
  }

  const client = createClient(authToken ? { url, authToken } : { url });
  return drizzle(client, { schema }) as unknown as Db;
}
