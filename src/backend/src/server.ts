import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createHttpAdapter } from "./adapters/http.ts";
import { createLedgerAdapter } from "./adapters/ledger.ts";
import { createRegistry } from "./adapters/types.ts";
import type { AppDeps, AppEnv } from "./appEnv.ts";
import { mintApprovalToken } from "./approvals/token.ts";
import { appendAudit } from "./audit/log.ts";
import { createDb, migrate, type Db } from "./db/client.ts";
import { getAction } from "./db/repo.ts";
import { env, requireApprovalConfig } from "./env.ts";
import { createResendClient, createResendSender, type ApprovalSender } from "./notify/email.ts";
import { createSmtpSender, createSmtpTransport, verifySmtp } from "./notify/smtp.ts";
import { createClassifier, createStubClassifier, CLASSIFIER_MODEL } from "./policy/classify.ts";
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

  // The site, served from the same origin as the API. Mounted last so it can
  // never shadow a route above it, and only when a document root is
  // configured — the test suite builds an API-only app and should 404 on `/`
  // rather than depend on a directory being present.
  //
  // Same origin is the whole point: no CORS on the visit counter, one
  // certificate, and the page can call `/v1/site/visits` as a relative path
  // in production exactly as it does in development.
  if (deps.siteRoot) {
    // serveStatic resolves `root` against process.cwd(), so an absolute path
    // has to be made relative to it or every asset 404s when the server is
    // started from anywhere but the repo root.
    const relativeRoot = path.relative(process.cwd(), deps.siteRoot) || ".";

    app.use(
      "/*",
      serveStatic({
        root: relativeRoot,
        // Directory requests land on index.html; `/audit` also resolves to
        // `audit.html`, so the pages have clean URLs without a redirect table.
        rewriteRequestPath: (requestPath) => {
          if (requestPath === "/") return "/index.html";
          if (/\.[a-z0-9]+$/i.test(requestPath)) return requestPath;
          return `${requestPath}.html`;
        },
      }),
    );
  }

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

export async function boot(): Promise<void> {
  // Before anything else. A server that starts and only discovers it cannot ask
  // anyone about a payment on the first request is a server that fails in front
  // of an audience.
  const approval = requireApprovalConfig();

  const db = createDb(env.ADEIA_DB_PATH);
  migrate(db);

  const adapters = createRegistry([createLedgerAdapter(), createHttpAdapter()]);
  const emailConfig = { fromEmail: approval.fromEmail, publicBaseUrl: approval.publicBaseUrl };

  let send: ApprovalSender;
  let transportLine: string;

  if (approval.transport.kind === "smtp") {
    const { host, port, user } = approval.transport;
    const smtp = createSmtpTransport(approval.transport);

    // Checked here, where the failure is loud and fixable, rather than
    // discovered by the first over-limit action — at which point the payment is
    // correctly paused and nobody has been told. This also catches the case the
    // missing-variable check cannot: credentials that are present but wrong.
    try {
      await verifySmtp(smtp);
    } catch (err) {
      throw new Error(
        `SMTP refused the connection or the credentials (${host}:${port} as ${user}).\n` +
          `  ${err instanceof Error ? err.message : String(err)}\n` +
          "  For Gmail: 2-Step Verification must be on, and SMTP_PASSWORD must be a\n" +
          "  16-character app password — not the account password.",
      );
    }

    send = createSmtpSender(emailConfig, smtp);
    transportLine = `smtp ${host}:${port} as ${user}`;
  } else {
    send = createResendSender(emailConfig, createResendClient(approval.transport.apiKey));
    transportLine = "resend";
  }

  // Falls back to the stub when no key is set, which refuses every
  // classification rather than allowing it.
  const classifier = env.ANTHROPIC_API_KEY
    ? createClassifier({ apiKey: env.ANTHROPIC_API_KEY })
    : createStubClassifier();
  const classifierLine = env.ANTHROPIC_API_KEY
    ? CLASSIFIER_MODEL
    : "none — classified methods will ask a person";

  // src/backend/src/server.ts -> src/frontend
  const siteRoot = fileURLToPath(new URL("../../frontend", import.meta.url));

  // All three or none. A half-configured OAuth app produces a login that fails
  // at GitHub with a message the user cannot act on, so the dashboard treats it
  // as unconfigured and says what is missing.
  const oauth =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_REDIRECT_URI
      ? {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
          redirectUri: env.GITHUB_REDIRECT_URI,
        }
      : undefined;

  const app = createApp({
    db,
    adapters,
    approverEmail: approval.approverEmail,
    onApprovalNeeded: createApprovalNotifier(db, send, approval.approverEmail, approval.tokenTtlMs),
    classifier,
    oauth,
    siteRoot,
  });

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[adeia] listening on http://localhost:${info.port}  (db: ${env.ADEIA_DB_PATH})`);
    console.log(`[adeia] serving the site from ${siteRoot}`);
    // Names and addresses only. No key is ever logged.
    console.log(`[adeia] adapters: ${[...adapters.values()].map((a) => a.name).join(", ")}`);
    // Said out loud, every boot. A permission layer that has quietly stopped
    // executing anything looks identical, from the outside, to one that is
    // working — the audit trail fills up either way. The one thing that must
    // never happen silently is nobody knowing which of the two this is.
    console.log(`[adeia] NO PAYMENT PROCESSOR ATTACHED — payments are authorised and recorded;`);
    console.log(`[adeia]   no money moves. Register a processor adapter to change that.`);
    console.log(`[adeia] approvals: ${approval.approverEmail} via ${approval.publicBaseUrl}`);
    // The transport and the sending identity, never the credential.
    console.log(`[adeia]   sending as ${approval.fromEmail} over ${transportLine}`);
    // Same reasoning as the payment line above: which classifier is answering
    // changes what runs unattended, so it is stated rather than inferred.
    console.log(`[adeia] risk classifier: ${classifierLine}`);
    console.log(
      `[adeia] dashboard: ${
        oauth ? `sign-in via GitHub, callback ${oauth.redirectUri}` : "sign-in not configured"
      }`,
    );
  });
}

// `import.meta.main` only exists on Node 24+; argv works on every supported version.
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) await boot();
