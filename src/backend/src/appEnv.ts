import type { MiddlewareHandler } from "hono";
import type { RequestDeps } from "./actions/service.ts";
import type { GithubOauthConfig } from "./auth/github.ts";

export interface AppDeps extends RequestDeps {
  /**
   * Present only when the deployment configured a GitHub OAuth app. Absent
   * means the dashboard explains how to set it up instead of offering a login
   * button that cannot work — the rest of the server is unaffected either way.
   */
  oauth?: GithubOauthConfig;

  /** Injected so the OAuth handshake can be tested without a network. */
  fetch?: typeof fetch;

  /**
   * Recorded as `decided_by`. The token is the only authentication on the
   * approval page, so this is the address the link was *sent* to, not a
   * verified identity of whoever clicked.
   */
  approverEmail?: string;

  /**
   * Serves the landing page, when something is serving it from this process.
   *
   * Injected rather than built here, because reading files off a disk is the
   * one thing this app does that not every host can do. The Node entry point
   * passes `@hono/node-server`'s static handler; the serverless deployment
   * passes nothing, because the marketing pages are on a CDN in front and this
   * process never sees those requests. The tests pass nothing either and get an
   * API-only app that 404s on `/`.
   *
   * Mounted last, so it can never shadow a route.
   */
  staticMiddleware?: MiddlewareHandler<AppEnv>;
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
