import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createHttpAdapter } from "./adapters/http.ts";
import { createLedgerAdapter } from "./adapters/ledger.ts";
import { createRegistry } from "./adapters/types.ts";
import type { AppEnv } from "./appEnv.ts";
import { createDb, migrate } from "./db/client.node.ts";
import { createTursoDb } from "./db/client.turso.ts";
import { env, requireApprovalConfig, requireDatabaseConfig } from "./env.ts";
import { createResendClient, createResendSender, type ApprovalSender } from "./notify/email.ts";
import { createSmtpSender, createSmtpTransport, verifySmtp } from "./notify/smtp.ts";
import { createClassifier, createStubClassifier, CLASSIFIER_MODEL } from "./policy/classify.ts";
import { createApp, createApprovalNotifier } from "./server.ts";

/**
 * Adeia on Node: a long-lived process, a listening socket, and the landing
 * page served off the local disk.
 *
 * This is the development entry point and the one `npm run dev` starts. It is
 * separate from `server.ts` because everything imported above is something a
 * serverless host either cannot do or should not be asked to: a native SQLite
 * addon, an SMTP socket, a filesystem to read HTML out of, a port to bind.
 *
 * `server.ts` builds the same routes with none of it, so the deployed function
 * never pulls a compiler-built binding into its bundle for the sake of a code
 * path it will not take.
 */

/**
 * The landing page, off the disk.
 *
 * Only this entry point has one. In production the ten marketing pages are on
 * a CDN and the deployed function never sees a request for them.
 */
function createStaticMiddleware(siteRoot: string) {
  // serveStatic resolves `root` against process.cwd(), so an absolute path has
  // to be made relative to it or every asset 404s when the server is started
  // from anywhere but the repo root.
  const relativeRoot = path.relative(process.cwd(), siteRoot) || ".";

  return serveStatic<AppEnv>({
    root: relativeRoot,
    // Directory requests land on index.html; `/audit` also resolves to
    // `audit.html`, so the pages have clean URLs without a redirect table.
    rewriteRequestPath: (requestPath) => {
      if (requestPath === "/") return "/index.html";
      if (/\.[a-z0-9]+$/i.test(requestPath)) return requestPath;
      return `${requestPath}.html`;
    },
  });
}

export async function boot(): Promise<void> {
  // Before anything else. A server that starts and only discovers it cannot ask
  // anyone about a payment on the first request is a server that fails in front
  // of an audience.
  const approval = requireApprovalConfig();

  /* Turso when it is configured, the local file otherwise. Migrations only run
     in-process for the local file: against a hosted database they are applied
     ahead of the deploy by `npm run db:migrate`, so a cold start never races
     another cold start to alter the same tables. */
  const database = requireDatabaseConfig();
  const db =
    database.kind === "turso"
      ? createTursoDb(database.url, database.authToken)
      : createDb(database.path);
  if (database.kind === "file") migrate(db);

  const dbLine =
    database.kind === "turso" ? `turso ${new URL(database.url).host}` : database.path;

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
    staticMiddleware: createStaticMiddleware(siteRoot),
  });

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[adeia] listening on http://localhost:${info.port}  (db: ${dbLine})`);
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
