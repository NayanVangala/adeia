import { z } from "zod";

/**
 * Loads `.env` from the repo root if it is there. Node throws when the file is
 * missing, which is the normal case in CI and in tests, so the miss is ignored.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
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
   * Phase 4. Test-mode keys only.
   *
   * This prefix check is the only thing standing between a rehearsal and a real
   * charge against a real card, so it is enforced on *parse* — anything that
   * imports this module with a live key set fails immediately, not just the
   * server.
   *
   * It is optional rather than required because `scripts/seed.ts` and
   * `scripts/gen-docs.ts` import this module and have nothing to do with
   * payments; making it required would mean needing a Stripe account to seed a
   * database or regenerate a JSON schema. The server's own hard requirement is
   * enforced separately, by `requireStripeSecretKey()` in `boot()`.
   */
  STRIPE_SECRET_KEY: optional(
    z
      .string()
      .startsWith(
        "sk_test_",
        'refusing a Stripe key that is not test mode — it must start with "sk_test_"',
      ),
  ),

  // --- Phase 5: approvals ---
  // Optional here for the same reason as the Stripe key: the seed and docs
  // scripts import this module. `requireApprovalConfig()` is the server's hard
  // requirement.

  /** Resend API key. Looks like `re_…`; the prefix is not enforced. */
  RESEND_API_KEY: optional(z.string().min(1)),
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
 * The server will not start without a test-mode Stripe key. Refusing to boot is
 * deliberate: the alternative — starting up and quietly not executing payments,
 * or falling back to a fake adapter — produces a demo that looks like it works
 * and moves no money.
 */
export function requireStripeSecretKey(e: Env = env): string {
  if (!e.STRIPE_SECRET_KEY) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. The payment adapter cannot run without it.\n" +
        "  Get a test key from https://dashboard.stripe.com/test/apikeys and put it in .env:\n" +
        "    STRIPE_SECRET_KEY=sk_test_...",
    );
  }
  return e.STRIPE_SECRET_KEY;
}

export interface ApprovalConfig {
  resendApiKey: string;
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
export function requireApprovalConfig(e: Env = env): ApprovalConfig {
  const missing = (
    [
      ["RESEND_API_KEY", e.RESEND_API_KEY],
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
    resendApiKey: e.RESEND_API_KEY!,
    fromEmail: e.APPROVAL_FROM_EMAIL!,
    approverEmail: e.APPROVER_EMAIL!,
    publicBaseUrl: e.PUBLIC_BASE_URL!,
    tokenTtlMs: e.APPROVAL_TOKEN_TTL_MS,
  };
}

loadDotEnv();

export const env: Env = loadEnv();
