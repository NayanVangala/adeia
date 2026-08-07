import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * All five tables land in Phase 1. Later phases add columns; they do not add
 * tables. Timestamps are ISO-8601 UTC strings, money is integer cents, and
 * anything marked `(json)` is a JSON string in a text column.
 */

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** sha256 hex of the plaintext API key. The key itself is never stored. */
  apiKeyHash: text("api_key_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
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
