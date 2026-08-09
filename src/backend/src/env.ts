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

loadDotEnv();

export const env: Env = loadEnv();
