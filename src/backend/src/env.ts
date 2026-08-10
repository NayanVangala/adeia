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
