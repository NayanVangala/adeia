import { app } from "../../lib/app.ts";

/**
 * Every Adeia route, as one Next.js handler.
 *
 * Hono's `app.fetch` takes a Request and returns a Response, which is exactly
 * what a Next.js route handler is. So the routing stays in `server.ts` — one
 * router, matching the same paths in the same order, exercised by the same 499
 * tests — and Next.js provides the host rather than a second place for a URL to
 * be defined.
 *
 * The alternative was a file per route under `app/`. That would have moved
 * `/v1/actions`, `/approvals`, `/auth` and `/dashboard` out of the router the
 * tests drive and into a directory layout the tests cannot see, four days
 * before a deadline, for no behaviour anybody would notice.
 *
 * An optional catch-all — `[[...route]]` — rather than `[...route]`, so `/`
 * reaches it too and 404s as JSON like every other unmatched path, instead of
 * Next.js answering with its own HTML error page.
 *
 * Node rather than edge: `node:crypto`, the Anthropic SDK and the Turso client
 * all want it, and there is nothing here that a cold start makes worse — the
 * server has no background work, and expiry is evaluated when a row is read.
 */
export const runtime = "nodejs";

/**
 * Never prerendered. Every path here reads the database or a cookie, and a
 * build-time snapshot of the dashboard would be somebody else's dashboard.
 */
export const dynamic = "force-dynamic";

const handler = (request: Request): Response | Promise<Response> => app().fetch(request);

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
