import type { RequestDeps } from "./actions/service.ts";

/**
 * The Hono context shape shared by every middleware and route.
 *
 * `deps` is set once by an app-level middleware in `server.ts` rather than
 * imported, so tests can build an app around an in-memory database and a fake
 * adapter without touching module state.
 *
 * `projectId` is set by `apiKeyAuth` and is the only thing downstream code may
 * use to scope a query — never a value from the request body or path.
 */
export interface AppEnv {
  Variables: {
    deps: RequestDeps;
    projectId: string;
  };
}
