import type { ActionRecord, ActionStatus, Decision } from "@adeia/shared";
import { and, eq, gte, sql } from "drizzle-orm";
import { newId } from "../ids.ts";
import type { Policy } from "../policy/evaluate.ts";
import type { Db } from "./client.ts";
import {
  actions,
  auditEvents,
  policies,
  projects,
  type ActionRow,
  type AuditRow,
  type PolicyRow,
  type ProjectRow,
} from "./schema.ts";

export type Project = ProjectRow;
export type { AuditRow, PolicyRow };

const now = (): string => new Date().toISOString();

/**
 * Start of the current day in UTC, as an ISO-8601 string. Deliberately not
 * local time: a local-midnight boundary makes the daily cap shift by the
 * timezone offset, so the same demo behaves differently in the afternoon.
 */
export function utcMidnightIso(at: Date = new Date()): string {
  return `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

// --- projects ---------------------------------------------------------------

export interface NewProject {
  id?: string;
  name: string;
  /** sha256 hex. The plaintext key must never reach this function. */
  apiKeyHash: string;
}

export function insertProject(db: Db, p: NewProject): Project {
  const [row] = db
    .insert(projects)
    .values({
      id: p.id ?? newId("proj"),
      name: p.name,
      apiKeyHash: p.apiKeyHash,
      createdAt: now(),
    })
    .returning()
    .all();
  return row!;
}

export function getProjectByKeyHash(db: Db, hash: string): Project | null {
  return db.select().from(projects).where(eq(projects.apiKeyHash, hash)).get() ?? null;
}

export function getProject(db: Db, id: string): Project | null {
  return db.select().from(projects).where(eq(projects.id, id)).get() ?? null;
}

// --- policies ---------------------------------------------------------------

export interface NewPolicy {
  id?: string;
  projectId: string;
  actionType: string;
  maxAmountCents?: number | null;
  hardMaxAmountCents?: number | null;
  dailyCapCents?: number | null;
  allowedRecipients?: string[] | null;
  requiresApproval?: boolean;
}

export function insertPolicy(db: Db, p: NewPolicy): PolicyRow {
  const [row] = db
    .insert(policies)
    .values({
      id: p.id ?? newId("pol"),
      projectId: p.projectId,
      actionType: p.actionType,
      maxAmountCents: p.maxAmountCents ?? null,
      hardMaxAmountCents: p.hardMaxAmountCents ?? null,
      dailyCapCents: p.dailyCapCents ?? null,
      allowedRecipients: p.allowedRecipients ? JSON.stringify(p.allowedRecipients) : null,
      requiresApproval: p.requiresApproval ? 1 : 0,
      createdAt: now(),
    })
    .returning()
    .all();
  return row!;
}

/**
 * Maps a stored row into the shape `evaluate()` expects: JSON parsed, 0/1
 * coerced to boolean, and absent limits left as `null` rather than collapsed
 * to `0` — the two mean opposite things to the policy engine.
 */
export function toPolicy(row: PolicyRow): Policy {
  let allowedRecipients: string[] | null = null;
  if (row.allowedRecipients !== null) {
    const parsed: unknown = JSON.parse(row.allowedRecipients);
    if (!Array.isArray(parsed) || parsed.some((r) => typeof r !== "string")) {
      throw new Error(`policy ${row.id}: allowed_recipients is not a JSON array of strings`);
    }
    allowedRecipients = parsed as string[];
  }

  return {
    actionType: row.actionType,
    maxAmountCents: row.maxAmountCents ?? null,
    hardMaxAmountCents: row.hardMaxAmountCents ?? null,
    dailyCapCents: row.dailyCapCents ?? null,
    allowedRecipients,
    requiresApproval: row.requiresApproval === 1,
  };
}

export function getPolicy(db: Db, projectId: string, actionType: string): PolicyRow | null {
  return (
    db
      .select()
      .from(policies)
      .where(and(eq(policies.projectId, projectId), eq(policies.actionType, actionType)))
      .get() ?? null
  );
}

// --- actions ----------------------------------------------------------------

export interface NewAction {
  id?: string;
  projectId: string;
  type: string;
  params: unknown;
  status: ActionStatus;
  idempotencyKey: string;
  decision?: Decision | null;
  decisionReason?: string | null;
}

/** Fields a status transition is allowed to touch. Nothing else is mutable. */
export interface StatusPatch {
  status: ActionStatus;
  decision?: Decision | null;
  decisionReason?: string | null;
  result?: unknown;
  error?: string | null;
  decidedAt?: string | null;
  executedAt?: string | null;
}

export function toActionRecord(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    params: JSON.parse(row.params) as Record<string, unknown>,
    status: row.status as ActionStatus,
    decision: (row.decision as Decision | null) ?? null,
    decisionReason: row.decisionReason ?? null,
    idempotencyKey: row.idempotencyKey,
    result: row.result ? (JSON.parse(row.result) as Record<string, unknown>) : null,
    error: row.error ?? null,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt ?? null,
    executedAt: row.executedAt ?? null,
  };
}

/** Throws a unique-constraint error on a repeated (project_id, idempotency_key). */
export function insertAction(db: Db, a: NewAction): ActionRecord {
  const [row] = db
    .insert(actions)
    .values({
      id: a.id ?? newId("act"),
      projectId: a.projectId,
      type: a.type,
      params: JSON.stringify(a.params),
      status: a.status,
      decision: a.decision ?? null,
      decisionReason: a.decisionReason ?? null,
      idempotencyKey: a.idempotencyKey,
      createdAt: now(),
    })
    .returning()
    .all();
  return toActionRecord(row!);
}

export function getAction(db: Db, id: string): ActionRecord | null {
  const row = db.select().from(actions).where(eq(actions.id, id)).get();
  return row ? toActionRecord(row) : null;
}

export function updateActionStatus(db: Db, id: string, patch: StatusPatch): ActionRecord {
  const values: Partial<ActionRow> = { status: patch.status };
  if (patch.decision !== undefined) values.decision = patch.decision;
  if (patch.decisionReason !== undefined) values.decisionReason = patch.decisionReason;
  if (patch.result !== undefined) values.result = patch.result === null ? null : JSON.stringify(patch.result);
  if (patch.error !== undefined) values.error = patch.error;
  if (patch.decidedAt !== undefined) values.decidedAt = patch.decidedAt;
  if (patch.executedAt !== undefined) values.executedAt = patch.executedAt;

  const [row] = db.update(actions).set(values).where(eq(actions.id, id)).returning().all();
  if (!row) throw new Error(`action ${id} not found`);
  return toActionRecord(row);
}

export function findActionByIdempotencyKey(
  db: Db,
  projectId: string,
  key: string,
): ActionRecord | null {
  const row = db
    .select()
    .from(actions)
    .where(and(eq(actions.projectId, projectId), eq(actions.idempotencyKey, key)))
    .get();
  return row ? toActionRecord(row) : null;
}

/**
 * Money actually spent today, in the given currency. Only `executed` rows count
 * — a pending or denied action has moved no money.
 *
 * The cap is per-currency because this filter is per-currency; no conversion
 * happens anywhere. Two currencies means two independent caps. That is a
 * documented MVP limitation, not a bug.
 */
export function sumSpentTodayCents(db: Db, projectId: string, currency: string): number {
  const row = db
    .select({
      total: sql<number>`coalesce(sum(json_extract(${actions.params}, '$.amountCents')), 0)`,
    })
    .from(actions)
    .where(
      and(
        eq(actions.projectId, projectId),
        eq(actions.status, "executed"),
        sql`json_extract(${actions.params}, '$.currency') = ${currency}`,
        gte(actions.createdAt, utcMidnightIso()),
      ),
    )
    .get();
  return Number(row?.total ?? 0);
}

// --- audit ------------------------------------------------------------------

export interface NewAuditEvent {
  id?: string;
  actionId?: string | null;
  projectId: string;
  event: string;
  data?: string | null;
}

export function insertAuditEvent(db: Db, e: NewAuditEvent): AuditRow {
  const [row] = db
    .insert(auditEvents)
    .values({
      id: e.id ?? newId("evt"),
      actionId: e.actionId ?? null,
      projectId: e.projectId,
      event: e.event,
      data: e.data ?? null,
      createdAt: now(),
    })
    .returning()
    .all();
  return row!;
}

/** Ordered by (created_at, id) — several events routinely share a millisecond. */
export function listAudit(db: Db, actionId: string): AuditRow[] {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.actionId, actionId))
    .orderBy(auditEvents.createdAt, auditEvents.id)
    .all();
}
