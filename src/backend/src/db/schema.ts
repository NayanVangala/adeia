import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * The five core tables land in Phase 1. Timestamps are ISO-8601 UTC strings,
 * money is integer cents, and anything marked `(json)` is a JSON string in a
 * text column.
 *
 * `users` and `sessions` arrive with the dashboard. They are about who is
 * looking at Adeia; everything above them is about what an agent asked to do.
 * The two are joined only by `projects.owner_user_id`.
 */

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** sha256 hex of the plaintext API key. The key itself is never stored. */
  apiKeyHash: text("api_key_hash").notNull().unique(),
  /**
   * Who may see this project in the dashboard. Nullable because every project
   * seeded from the command line before the dashboard existed has no owner,
   * and because `npm run seed` still creates ownerless projects for local work.
   *
   * A null owner is not "visible to everyone" — the dashboard query filters on
   * an explicit user id, so an ownerless project is visible to nobody.
   */
  ownerUserId: text("owner_user_id"),
  /**
   * When this project was archived, or null while it is live.
   *
   * Archiving is what this product has instead of deleting. Deleting a project
   * would delete its audit trail, and an append-only record of what an agent
   * did is the thing being sold — a dashboard that can erase the evidence
   * argues against itself.
   *
   * It is not a display flag. An archived project's key stops authenticating,
   * which is the point: archiving is how you stop an agent you no longer trust
   * without destroying the record of what it already did.
   */
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
});

/**
 * A person who has signed in. Distinct from a project: a user may own several.
 *
 * Identity comes from GitHub and is keyed on the numeric id rather than the
 * login, because a login can be renamed and then claimed by somebody else.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  /** GitHub's numeric account id, as a string. Stable across renames. */
  githubId: text("github_id").notNull().unique(),
  login: text("login").notNull(),
  /** May be absent: GitHub allows a private email with no verified address. */
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull(),
  lastLoginAt: text("last_login_at").notNull(),
});

/**
 * A signed-in browser.
 *
 * The cookie holds 32 bytes of CSPRNG output; only `sha256(token)` is stored,
 * for the same reason approval tokens are hashed — a leaked table must not be
 * a set of live logins. Expiry is absolute, not sliding.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    /** Set when the user signs out. A revoked session is never resurrected. */
    revokedAt: text("revoked_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * An in-flight OAuth handshake.
 *
 * The `state` parameter is what stops a third party from feeding us their own
 * authorization code and binding your browser to their GitHub account. It is
 * stored server-side, single-use, and short-lived; a callback whose state is
 * unknown, spent or stale is refused rather than followed.
 */
export const oauthStates = sqliteTable("oauth_states", {
  id: text("id").primaryKey(),
  /** sha256 hex. The plaintext only ever exists in the redirect URL. */
  stateHash: text("state_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull(),
  usedAt: text("used_at"),
});

export const policies = sqliteTable(
  "policies",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    actionType: text("action_type").notNull(),
    /** Above this → require_approval. null means no per-action limit. */
    maxAmountCents: integer("max_amount_cents"),
    /** Above this → deny outright. Beats every approval rule. */
    hardMaxAmountCents: integer("hard_max_amount_cents"),
    /** spentToday + amount above this → deny. Per-currency. */
    dailyCapCents: integer("daily_cap_cents"),
    /** (json) string[] | null. null means any recipient is allowed. */
    allowedRecipients: text("allowed_recipients"),
    /** 0/1. Forces approval regardless of amount. */
    requiresApproval: integer("requires_approval").notNull().default(0),
    /**
     * (json) Rules that belong to one action type and have no meaning for the
     * others. The money columns above stayed as columns because they are
     * queried and because every one of them predates a second action type;
     * anything new lands here rather than adding a column that is null for
     * every row of a different type.
     *
     * For `http`: `{ allowedHosts, approvalMethods, deniedMethods,
     * maxCallsPerDay }`. Null for `payment`.
     */
    config: text("config"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("policies_project_action_unique").on(t.projectId, t.actionType)],
);

export const actions = sqliteTable(
  "actions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    type: text("type").notNull(),
    /** (json) the validated request params, e.g. PaymentParams. */
    params: text("params").notNull(),
    status: text("status").notNull(),
    /** allow | require_approval | deny */
    decision: text("decision"),
    decisionReason: text("decision_reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** (json) adapter output, e.g. { paymentIntentId, status, ... }. */
    result: text("result"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    executedAt: text("executed_at"),
  },
  (t) => [
    uniqueIndex("actions_project_idempotency_unique").on(t.projectId, t.idempotencyKey),
    index("actions_project_status_created_idx").on(t.projectId, t.status, t.createdAt),
  ],
);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  actionId: text("action_id")
    .notNull()
    .references(() => actions.id),
  /** sha256 hex of the approval token. The plaintext token is NEVER stored. */
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  /** approve | deny */
  decision: text("decision"),
  decidedAt: text("decided_at"),
  decidedBy: text("decided_by"),
  createdAt: text("created_at").notNull(),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").references(() => actions.id),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    event: text("event").notNull(),
    /** (json) redacted at write time. */
    data: text("data"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("audit_events_action_created_idx").on(t.actionId, t.createdAt)],
);

/**
 * Landing-page visit counter.
 *
 * One row per visitor per UTC day. `visitorHash` is
 * sha256(salt + ip + user-agent) — the raw address is never written, and the
 * salt is per-deployment, so a leaked table cannot be walked back to an IP.
 *
 * The unique index is what makes the figure honest: refreshing the page all
 * afternoon adds one row, not fifty. The number it produces is unique
 * visitor-days, which is what the page says it is.
 */
export const siteVisits = sqliteTable(
  "site_visits",
  {
    id: text("id").primaryKey(),
    /** UTC date, YYYY-MM-DD. */
    day: text("day").notNull(),
    visitorHash: text("visitor_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("site_visits_day_visitor_uq").on(t.day, t.visitorHash),
    index("site_visits_day_idx").on(t.day),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type PolicyRow = typeof policies.$inferSelect;
export type NewPolicyRow = typeof policies.$inferInsert;
export type ActionRow = typeof actions.$inferSelect;
export type NewActionRow = typeof actions.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
export type AuditRow = typeof auditEvents.$inferSelect;
export type NewAuditRow = typeof auditEvents.$inferInsert;
export type SiteVisitRow = typeof siteVisits.$inferSelect;
export type NewSiteVisitRow = typeof siteVisits.$inferInsert;

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type OauthStateRow = typeof oauthStates.$inferSelect;
export type NewOauthStateRow = typeof oauthStates.$inferInsert;
