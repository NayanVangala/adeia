import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import Stripe from "stripe";
import { createStripeAdapter } from "./adapters/stripe.ts";
import { createRegistry } from "./adapters/types.ts";
import type { AppDeps, AppEnv } from "./appEnv.ts";
import { mintApprovalToken } from "./approvals/token.ts";
import { appendAudit } from "./audit/log.ts";
import { createDb, migrate, type Db } from "./db/client.ts";
import { getAction } from "./db/repo.ts";
import { env, requireApprovalConfig, requireStripeSecretKey } from "./env.ts";
import { createResendClient, createResendSender, type ApprovalSender } from "./notify/email.ts";
import { createActionRoutes } from "./routes/actions.ts";
import { createApprovalRoutes } from "./routes/approvals.ts";
import { createAuditRoutes } from "./routes/audit.ts";

export type { AppDeps };

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/v1/actions", createActionRoutes());
  // Mounted after the action routes; `/actions/:id/audit` is two segments and
  // cannot collide with `/actions/:id`.
  app.route("/v1", createAuditRoutes());
  app.route("/approvals", createApprovalRoutes());

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
    const action = getAction(db, actionId);
    if (!action) return;

    try {
      const { token, expiresAt } = await mintApprovalToken(db, actionId, ttlMs);
      await send({ to: approverEmail, action, token });

      appendAudit(db, {
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

export function boot(): void {
  // Both before anything else. A server that starts and only discovers it
  // cannot take payments, or cannot ask anyone about them, on the first request
  // is a server that fails in front of an audience.
  const stripeSecretKey = requireStripeSecretKey();
  const approval = requireApprovalConfig();

  const db = createDb(env.ADEIA_DB_PATH);
  migrate(db);

  const adapters = createRegistry([createStripeAdapter(new Stripe(stripeSecretKey))]);
  const send = createResendSender(
    { fromEmail: approval.fromEmail, publicBaseUrl: approval.publicBaseUrl },
    createResendClient(approval.resendApiKey),
  );

  const app = createApp({
    db,
    adapters,
    approverEmail: approval.approverEmail,
    onApprovalNeeded: createApprovalNotifier(db, send, approval.approverEmail, approval.tokenTtlMs),
  });

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[adeia] listening on http://localhost:${info.port}  (db: ${env.ADEIA_DB_PATH})`);
    // Names and addresses only. No key is ever logged.
    console.log(`[adeia] adapters: ${[...adapters.values()].map((a) => a.name).join(", ")}  (stripe test mode)`);
    console.log(`[adeia] approvals: ${approval.approverEmail} via ${approval.publicBaseUrl}`);
  });
}

// `import.meta.main` only exists on Node 24+; argv works on every supported version.
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) boot();
