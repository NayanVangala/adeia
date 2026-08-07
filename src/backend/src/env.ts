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

/**
 * Phase 1 needs nothing beyond these three, so every one of them has a default
 * and importing this module can never throw. Later phases add required keys
 * (STRIPE_SECRET_KEY in P4, the Resend block in P5) and boot starts to depend
 * on real configuration.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  ADEIA_DB_PATH: z.string().min(1).default("./adeia.db"),
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

loadDotEnv();

export const env: Env = loadEnv();
