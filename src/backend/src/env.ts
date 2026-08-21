import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Loads `.env` from the repo root if it is there. Node throws when the file is
 * missing, which is the normal case in CI, in tests and in production, so the
 * miss is ignored.
 *
 * The path is resolved off this module rather than off the working directory.
 * `npm run dev` and vitest both run from the repo root and would have found it
 * either way; Next.js does not, and a bare `loadEnvFile()` would quietly look
 * for `src/web/.env`, find nothing, and leave the server to fail later with a
 * missing-variable error that points nowhere near the cause.
 */
function loadDotEnv(): void {
  /* Assembled at runtime, deliberately, rather than written as one literal.
     `new URL("../../../.env", import.meta.url)` is not a path to a bundler —
     it is a static asset reference. Turbopack resolved it at build time and
     copied the developer's .env into the deployment, Turso token and SMTP
     password and all, where `loadEnvFile` then found it and quietly preferred
     it to the variables the host had set. That is how a production deployment
     came to hand out a GitHub redirect pointing at localhost.

     Splitting the path defeats that analysis. Nothing is lost: a hosted
     environment supplies its own variables and has no .env to read. */
  /* A managed host sets the variables itself, and must not be overridden by a
     file. Next traces `.env` into the function whatever the tracing config
     says, so on a build produced from a developer's machine that file is
     present in production carrying their credentials — and without this guard
     `loadEnvFile` prefers it to what the platform set. The symptom was a
     production sign-in redirecting to `http://localhost:3000`, which is the
     harmless-looking end of a leak that also included the Turso token and the
     SMTP password. */
  if (process.env.VERCEL) return;

  const here = dirname(fileURLToPath(import.meta.url));
  try {
    // src/backend/src/ -> the repo root
    process.loadEnvFile(join(here, "..", "..", "..", ".env"));
  } catch {
    // no .env file — env comes from the real environment
  }
}

/** An unset variable and one set to "" mean the same thing: absent. */
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    schema.optional(),
  );
}

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  ADEIA_DB_PATH: z.string().min(1).default("./adeia.db"),

  /**
   * Turso. Set both and the server talks to libSQL over the network instead of
   * to `ADEIA_DB_PATH` on the local disk — which is what production has to do,
   * because nothing free gives a server a persistent volume.
   *
   * Unset, the local file is used. `npm run dev` therefore needs no account,
   * and the test suite is unaffected either way.
   */
  TURSO_DATABASE_URL: optional(z.string().url()),
  /** Not needed for a `file:` URL; required for anything remote. */
  TURSO_AUTH_TOKEN: optional(z.string().min(1)),

  // --- Phase 5: approvals ---
  // Optional here because `scripts/seed.ts` and `scripts/gen-docs.ts` import
  // this module and have nothing to do with approvals; making them required
  // would mean needing an email account to seed a database or regenerate a
  // JSON schema. `requireApprovalConfig()` is the server's hard requirement.

  /** Resend API key. Looks like `re_…`; the prefix is not enforced. */
  RESEND_API_KEY: optional(z.string().min(1)),

  /**
   * SMTP, the alternative to Resend. Set `SMTP_USER` and `SMTP_PASSWORD` and
   * approval mail goes out over SMTP instead; the defaults point at Gmail.
   *
   * `SMTP_PASSWORD` is an **app password**, not an account password — Gmail
   * rejects the latter over SMTP, and an account password does not belong in a
   * `.env` file regardless.
   */
  SMTP_HOST: z.string().min(1).default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(465),
  SMTP_USER: optional(z.string().min(1)),
  SMTP_PASSWORD: optional(z.string().min(1)),
  /** Must be a sender Resend has verified for your domain. */
  APPROVAL_FROM_EMAIL: optional(z.string().email()),
  /** Where approval requests land. One approver per deployment in the MVP. */
  APPROVER_EMAIL: optional(z.string().email()),
  /**
   * Must be publicly reachable — a tunnel URL in development. A `localhost`
   * link in an email is useless on the phone the approver is holding.
   */
  PUBLIC_BASE_URL: optional(
    z
      .string()
      .url()
      .transform((u) => u.replace(/\/+$/, "")),
  ),
  APPROVAL_TOKEN_TTL_MS: z.coerce.number().int().positive().default(86_400_000),

  // --- risk classifier ---

  /**
   * Powers the risk classifier, which answers the `classify` outcome for
   * methods an operator listed in `classifyMethods`.
   *
   * Optional. Without it the server runs `createStubClassifier`, which refuses
   * every classification and sends the action to a person — so a policy that
   * opened methods to a classifier that was never configured produces approval
   * emails rather than unattended writes. A missing key must not be a quiet
   * upgrade in what an agent may do on its own.
   */
  ANTHROPIC_API_KEY: optional(z.string().min(1)),

  // --- dashboard sign-in ---
  //
  // All three optional together. Without them the dashboard serves a page
  // explaining how to configure it rather than a broken login button, and the
  // rest of the server runs exactly as before. Sign-in is a feature, not a
  // dependency of the fence.

  /** From the GitHub OAuth app. Public; it travels in the redirect URL. */
  GITHUB_CLIENT_ID: optional(z.string().min(1)),
  /** Secret. Never logged, never rendered, never leaves the token exchange. */
  GITHUB_CLIENT_SECRET: optional(z.string().min(1)),
  /**
   * Must match the callback registered on the OAuth app exactly, including
   * scheme and port. Deliberately its own variable rather than derived from
   * PUBLIC_BASE_URL: that one points at a tunnel whose hostname changes every
   * restart, and a moving callback is a login that breaks every morning.
   */
  GITHUB_REDIRECT_URI: optional(z.string().url()),

  /**
   * How many actions one project may create in a minute. Zero disables it.
   *
   * A ceiling on damage per unit time, not a pricing tier. The policy engine
   * already bounds what an agent may spend in a day; this bounds how fast a
   * loop can get there, and how quickly one project can fill the audit trail
   * everybody else's queries have to read past.
   *
   * The default is high enough that no honest agent notices. An agent making
   * two requests a second, sustained, is not working.
   */
  ADEIA_ACTIONS_PER_MINUTE: z.coerce.number().int().min(0).default(120),

  // --- landing page visit counter ---

  /**
   * Salt for the visitor hash. The raw IP and user agent are never stored, only
   * sha256(salt + ip + ua), and the salt is what stops that hash from being a
   * rainbow table away from an address — the input space is small enough to
   * enumerate without one.
   *
   * The default is fine for local development. Set a real value in production;
   * changing it resets deduplication, so today's returning visitors count once
   * more and nothing else moves.
   */
  ADEIA_VISIT_SALT: z.string().min(1).default("adeia-dev-salt"),

  /**
   * Whether `x-forwarded-for` can be believed. Off by default: anyone can send
   * that header, so trusting it on a directly-exposed server lets a single
   * client inflate the count by changing one string. Turn it on only behind a
   * proxy that overwrites it.
   */
  ADEIA_TRUST_PROXY: z
    .preprocess((v) => v === "true" || v === "1", z.boolean())
    .default(false),

  /**
   * Origins allowed to call the public site endpoints, comma separated. The
   * landing page is served from a different origin in development (:5173) and
   * possibly in production too, so it needs to be named rather than assumed.
   */
  ADEIA_SITE_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim().replace(/\/+$/, ""))
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid environment:\n${detail}`);
  }
  return parsed.data;
}

/**
 * How approval mail leaves the building. Exactly one of these is chosen at
 * boot — the transport is not a runtime fallback, because a system that
 * silently switches the channel a human is expected to be watching is worse
 * than one that refuses to start.
 */
export type ApprovalTransport =
  | { kind: "smtp"; host: string; port: number; user: string; password: string }
  | { kind: "resend"; apiKey: string };

export interface ApprovalConfig {
  transport: ApprovalTransport;
  fromEmail: string;
  approverEmail: string;
  publicBaseUrl: string;
  tokenTtlMs: number;
}

/**
 * The server will not start without somewhere to send approval requests.
 *
 * Booting without this produces the worst possible failure: over-limit actions
 * pause correctly and then wait forever, because nothing ever tells a human
 * they were asked. That looks identical to a hung agent.
 */
/**
 * Picks the transport, and refuses rather than guessing.
 *
 * A half-filled SMTP block does **not** quietly fall back to Resend. Falling
 * back would mean the channel a human is watching changed because of a typo,
 * which is the one failure this whole function exists to prevent.
 */
function requireApprovalTransport(e: Env): ApprovalTransport {
  const hasSmtpUser = Boolean(e.SMTP_USER);
  const hasSmtpPassword = Boolean(e.SMTP_PASSWORD);

  if (hasSmtpUser !== hasSmtpPassword) {
    throw new Error(
      `SMTP is half-configured: ${hasSmtpUser ? "SMTP_PASSWORD" : "SMTP_USER"} is missing.\n` +
        "  Set both, or neither. Refusing to fall back to another transport — the\n" +
        "  approval channel is not something to switch by accident.\n" +
        "  SMTP_PASSWORD is an app password, not your account password.",
    );
  }

  if (hasSmtpUser && hasSmtpPassword) {
    return {
      kind: "smtp",
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      user: e.SMTP_USER!,
      password: e.SMTP_PASSWORD!,
    };
  }

  if (e.RESEND_API_KEY) return { kind: "resend", apiKey: e.RESEND_API_KEY };

  throw new Error(
    "no approval transport is configured. Set one of:\n" +
      "  SMTP_USER + SMTP_PASSWORD   (app password; SMTP_HOST/SMTP_PORT default to Gmail)\n" +
      "  RESEND_API_KEY              (requires a Resend account and a verified sender domain)",
  );
}

/** Where the rows actually live. */
export type DatabaseConfig =
  | { kind: "file"; path: string }
  | { kind: "turso"; url: string; authToken: string | undefined };

/**
 * Picks the database, and refuses rather than guessing.
 *
 * A remote URL with no token does not quietly fall back to the local file.
 * Falling back would mean a deployment that believes it is writing to Turso
 * silently keeping its records on a container filesystem that is discarded on
 * the next request — which is indistinguishable from working right up until
 * somebody looks for the audit trail.
 *
 * A `file:` URL is the exception: libSQL reads those locally and there is no
 * credential to present.
 */
export function requireDatabaseConfig(e: Env = env): DatabaseConfig {
  if (!e.TURSO_DATABASE_URL) {
    if (e.TURSO_AUTH_TOKEN) {
      throw new Error(
        "TURSO_AUTH_TOKEN is set but TURSO_DATABASE_URL is not.\n" +
          "  Set both to use Turso, or neither to use the local file at ADEIA_DB_PATH.\n" +
          "  Refusing to fall back to the local disk — a server that thinks it is\n" +
          "  writing to Turso and is not looks identical to one that works.",
      );
    }
    return { kind: "file", path: e.ADEIA_DB_PATH };
  }

  const local = e.TURSO_DATABASE_URL.startsWith("file:");
  if (!local && !e.TURSO_AUTH_TOKEN) {
    throw new Error(
      `TURSO_DATABASE_URL is remote (${e.TURSO_DATABASE_URL}) but TURSO_AUTH_TOKEN is not set.\n` +
        "  Get one with: turso db tokens create <database>",
    );
  }

  return { kind: "turso", url: e.TURSO_DATABASE_URL, authToken: e.TURSO_AUTH_TOKEN };
}

export function requireApprovalConfig(e: Env = env): ApprovalConfig {
  const missing = (
    [
      ["APPROVAL_FROM_EMAIL", e.APPROVAL_FROM_EMAIL],
      ["APPROVER_EMAIL", e.APPROVER_EMAIL],
      ["PUBLIC_BASE_URL", e.PUBLIC_BASE_URL],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `the approval flow is not configured. Missing: ${missing.join(", ")}\n` +
        "  PUBLIC_BASE_URL must be publicly reachable — use a tunnel in development:\n" +
        "    ngrok http 3000\n" +
        "  and re-set it every time the tunnel restarts, or emailed links point at a dead host.",
    );
  }

  return {
    transport: requireApprovalTransport(e),
    fromEmail: e.APPROVAL_FROM_EMAIL!,
    approverEmail: e.APPROVER_EMAIL!,
    publicBaseUrl: e.PUBLIC_BASE_URL!,
    tokenTtlMs: e.APPROVAL_TOKEN_TTL_MS,
  };
}

loadDotEnv();

export const env: Env = loadEnv();
