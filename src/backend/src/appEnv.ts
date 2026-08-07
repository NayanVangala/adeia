import type { Db } from "./db/client.ts";

/**
 * The Hono context shape shared by every middleware and route.
 *
 * `db` is set once by an app-level middleware in `server.ts` rather than
 * imported, so tests can build an app around an in-memory database without
 * touching module state. `projectId` is set by `apiKeyAuth` and is the only
 * thing downstream code should use to scope a query — never a value from the
 * request body or path.
 */
export interface AppEnv {
  Variables: {
    db: Db;
    projectId: string;
  };
}
