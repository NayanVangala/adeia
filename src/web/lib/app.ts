import { createHttpAdapter } from "../../backend/src/adapters/http.ts";
import { createLedgerAdapter } from "../../backend/src/adapters/ledger.ts";
import { createRegistry } from "../../backend/src/adapters/types.ts";
import type { AppEnv } from "../../backend/src/appEnv.ts";
import { createTursoWebDb } from "../../backend/src/db/client.turso.web.ts";
import { env, requireApprovalConfig, requireDatabaseConfig } from "../../backend/src/env.ts";
import { createResendClient, createResendSender } from "../../backend/src/notify/email.ts";
import { createSmtpSender, createSmtpTransport } from "../../backend/src/notify/smtp.ts";
import { createClassifier, createStubClassifier } from "../../backend/src/policy/classify.ts";
import { createApp, createApprovalNotifier } from "../../backend/src/server.ts";
import type { Hono } from "hono";

/**
 * Adeia as a serverless function.
 *
 * The counterpart to `server.node.ts`, and the same app: `createApp` builds
 * every route, and this file supplies only the things a host has to provide.
 * What differs is what this host can be asked for.
 *
 *   No listening socket.   Next.js owns the server; this exports a fetch handler.
 *   No local disk.         The database is Turso; the marketing pages are on a
 *                          CDN in front and never reach this function.
 *
 * SMTP still works — `requestAction` awaits `onApprovalNeeded`, so the send
 * completes before the response returns and there is no invocation to be frozen
 * mid-flight — but it is the slower and more fragile of the two here, so it
 * warns. See `warnAboutSmtp`.
 */

/**
 * SMTP is supported here and is not the right choice here.
 *
 * It works: the approval send is awaited inside the request, so it finishes
 * before the response does. What it costs is a TLS handshake and an
 * authentication round trip on every cold start, paid by whichever payment
 * happens to be the one that woke the function up — and consumer providers,
 * Gmail among them, routinely refuse or throttle mail from datacenter
 * addresses, which turns into approval requests that are never delivered and
 * an action that waits forever.
 *
 * Warned rather than refused, because a deployment that already has working
 * SMTP credentials should not be blocked from starting by a preference.
 */
function warnAboutSmtp(): void {
  console.warn(
    "[adeia] sending approval mail over SMTP from a serverless function.\n" +
      "  It works, but every cold start pays for a TLS handshake and a login,\n" +
      "  and consumer providers often refuse mail from datacenter addresses —\n" +
      "  which looks exactly like an approval nobody answered.\n" +
      "  RESEND_API_KEY is one HTTPS call and is the better fit here.",
  );
}

let cached: Hono<AppEnv> | undefined;

/**
 * Built once per instance, not once per request.
 *
 * A warm serverless instance serves many requests, and rebuilding the adapter
 * registry and the Turso client for each of them would add a connection setup
 * to every call for no reason. A cold start pays for it once.
 */
export function app(): Hono<AppEnv> {
  if (cached) return cached;

  const approval = requireApprovalConfig();
  const database = requireDatabaseConfig();

  /* Turso is not optional here. The local file would be a container filesystem
     that is discarded between invocations: every approval token minted would be
     unreadable by the request that comes back to spend it.

     Unlike `server.node.ts`, an explicit `file:` URL is refused too — see
     `createTursoWebDb`. This build has no native SQLite binding to open one
     with, because carrying one would tie the deployment to the architecture it
     was built on. */
  if (database.kind !== "turso") {
    throw new Error(
      "TURSO_DATABASE_URL is not set, and this deployment has no disk to fall back to.\n" +
        "  Anything written to a local file is discarded between invocations —\n" +
        "  including the approval token this server just emailed somebody.",
    );
  }

  const db = createTursoWebDb(database.url, database.authToken);

  const emailConfig = { fromEmail: approval.fromEmail, publicBaseUrl: approval.publicBaseUrl };
  const send =
    approval.transport.kind === "smtp"
      ? (warnAboutSmtp(), createSmtpSender(emailConfig, createSmtpTransport(approval.transport)))
      : createResendSender(emailConfig, createResendClient(approval.transport.apiKey));

  // Falls back to the stub when no key is set, which refuses every
  // classification rather than allowing it.
  const classifier = env.ANTHROPIC_API_KEY
    ? createClassifier({ apiKey: env.ANTHROPIC_API_KEY })
    : createStubClassifier();

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

  cached = createApp({
    db,
    adapters: createRegistry([createLedgerAdapter(), createHttpAdapter()]),
    approverEmail: approval.approverEmail,
    onApprovalNeeded: createApprovalNotifier(db, send, approval.approverEmail, approval.tokenTtlMs),
    classifier,
    oauth,
    // No staticMiddleware: the ten marketing pages are served by the CDN in
    // front of this, and a request for one never arrives here.
  });

  return cached;
}
