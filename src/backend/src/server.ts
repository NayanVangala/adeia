import { Hono } from "hono";
import type { AppDeps, AppEnv } from "./appEnv.ts";
import { mintApprovalToken } from "./approvals/token.ts";
import { appendAudit } from "./audit/log.ts";
import type { Db } from "./db/client.ts";
import { getAction } from "./db/repo.ts";
import { env } from "./env.ts";
import type { ApprovalSender } from "./notify/email.ts";
import { createActionRoutes } from "./routes/actions.ts";
import { createApprovalRoutes } from "./routes/approvals.ts";
import { createAuditRoutes } from "./routes/audit.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { createDashboardRoutes } from "./routes/dashboard.ts";
import { createSiteRoutes } from "./routes/site.ts";

export type { AppDeps };

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // CORS for the public site endpoints only. Scoped to `/v1/site/*` and to the
  // origins named in the environment: the action API is key-authenticated and
  // has no business being reachable from a browser on another origin.
  app.use("/v1/site/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && env.ADEIA_SITE_ORIGINS.includes(origin.replace(/\/+$/, ""))) {
      c.header("access-control-allow-origin", origin);
      c.header("vary", "origin");
    }
    if (c.req.method === "OPTIONS") {
      c.header("access-control-allow-methods", "GET, POST, OPTIONS");
      c.header("access-control-allow-headers", "content-type");
      c.header("access-control-max-age", "86400");
      return c.body(null, 204);
    }
    await next();
  });

  app.route("/v1/site", createSiteRoutes());
  app.route("/v1/actions", createActionRoutes());
  // Mounted after the action routes; `/actions/:id/audit` is two segments and
  // cannot collide with `/actions/:id`.
  app.route("/v1", createAuditRoutes());
  app.route("/approvals", createApprovalRoutes());
  app.route("/auth", createAuthRoutes());
  // Mounted at the root because the path is `/dashboard`, and before the
  // static handler so it is not shadowed by a `dashboard.html` that does not
  // exist.
  app.route("/", createDashboardRoutes());

  // The site, when this process is the thing serving it. Mounted last so it
  // can never shadow a route above it, and only when the entry point supplied
  // a handler — the test suite and the serverless deployment both build an
  // API-only app and 404 on `/`.
  //
  // In development that means same origin: no CORS on the visit counter, one
  // certificate, and the page calls `/v1/site/visits` as a relative path
  // exactly as it does in production, where a CDN answers the page and this
  // process answers the API.
  if (deps.staticMiddleware) app.use("/*", deps.staticMiddleware);

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    console.error("[adeia] unhandled error:", err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

/**
 * Mints a token, emails it, and records that it was sent.
 *
 * A send failure is logged and swallowed rather than thrown. The action is
 * already correctly `pending_approval`, and turning a mail-provider outage into
 * a 500 would tell the agent its request failed when the request in fact
 * succeeded and is waiting. The action expires normally if nobody ever decides.
 *
 * The plaintext token is never logged, not even on failure. It is a bearer
 * credential for releasing a payment.
 */
export function createApprovalNotifier(
  db: Db,
  send: ApprovalSender,
  approverEmail: string,
  ttlMs: number,
): (actionId: string, projectId: string) => Promise<void> {
  return async (actionId, projectId) => {
    const action = await getAction(db, actionId);
    if (!action) return;

    try {
      const { token, expiresAt } = await mintApprovalToken(db, actionId, ttlMs);
      await send({ to: approverEmail, action, token });

      await appendAudit(db, {
        actionId,
        projectId,
        event: "approval.sent",
        data: { to: approverEmail, expiresAt },
      });
    } catch (err) {
      console.error(
        `[adeia] FAILED to send the approval request for ${actionId}. ` +
          `It is waiting and nobody has been told.`,
        err,
      );
    }
  };
}

