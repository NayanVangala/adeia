import type { RequestDeps } from "./actions/service.ts";

export interface AppDeps extends RequestDeps {
  /**
   * Recorded as `decided_by`. The token is the only authentication on the
   * approval page, so this is the address the link was *sent* to, not a
   * verified identity of whoever clicked.
   */
  approverEmail?: string;

  /**
   * Absolute path to the directory holding the landing page. When set, the
   * app serves it from the same origin as the API; when absent, the app is
   * API-only, which is what the tests build.
   */
  siteRoot?: string;
}

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
    deps: AppDeps;
    projectId: string;
  };
}
