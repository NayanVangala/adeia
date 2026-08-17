import type { ActionRecord, ActionStatus, Decision } from "@adeia/shared";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { newId } from "../ids.ts";
import type { Policy } from "../policy/evaluate.ts";
import type { Db } from "./client.ts";
import {
  actions,
  approvals,
  auditEvents,
  oauthStates,
  policies,
  projects,
  sessions,
  siteVisits,
  users,
  type ActionRow,
  type ApprovalRow,
  type AuditRow,
  type PolicyRow,
  type OauthStateRow,
  type ProjectRow,
  type SessionRow,
  type UserRow,
} from "./schema.ts";

export type Project = ProjectRow;
export type { ApprovalRow, AuditRow, PolicyRow, SessionRow, UserRow };

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
  /** Absent for a project seeded from the command line, which nobody owns. */
  ownerUserId?: string;
}

export function insertProject(db: Db, p: NewProject): Project {
  const [row] = db
    .insert(projects)
    .values({
      id: p.id ?? newId("proj"),
      name: p.name,
      apiKeyHash: p.apiKeyHash,
      ownerUserId: p.ownerUserId ?? null,
      createdAt: now(),
    })
    .returning()
    .all();
  return row!;
}

/**
 * Every project one user owns, newest first.
 *
 * Filters on an explicit id, so a project with a null owner is returned to
 * nobody. That matters: `npm run seed` still creates ownerless projects, and
 * "unowned" must never read as "everyone's".
 */
export function listProjectsByOwner(db: Db, userId: string): Project[] {
  return db
    .select()
    .from(projects)
    .where(eq(projects.ownerUserId, userId))
    .orderBy(desc(projects.createdAt))
    .all();
}

/** Rotating a key replaces the hash; the old key stops working immediately. */
export function updateProjectKeyHash(db: Db, projectId: string, apiKeyHash: string): Project | null {
  const [row] = db
    .update(projects)
    .set({ apiKeyHash })
    .where(eq(projects.id, projectId))
    .returning()
    .all();
  return row ?? null;
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
  /**
   * Rules belonging to one action type. Serialised as it is given; `toPolicy`
   * is what validates the shape on the way back out, so a malformed config
   * fails when the policy is read rather than silently becoming no rules.
   */
  config?: Record<string, unknown> | null;
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
      config: p.config ? JSON.stringify(p.config) : null,
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
/** Parses a stored JSON column that must hold an array of strings, or null. */
function stringArrayColumn(raw: string | null, policyId: string, column: string): string[] | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`policy ${policyId}: ${column} is not a JSON array of strings`);
  }
  return parsed as string[];
}

export function toPolicy(row: PolicyRow): Policy {
  if (row.actionType === "http") return toHttpPolicy(row);
  if (row.actionType === "payment") return toPaymentPolicy(row);

  // A row for a type the engine has no rules for. Refusing here is what stops
  // it reaching evaluate() and being answered by the wrong rule set.
  throw new Error(`policy ${row.id}: unknown action type "${row.actionType}"`);
}

function toPaymentPolicy(row: PolicyRow): Policy {
  return {
    actionType: "payment",
    maxAmountCents: row.maxAmountCents ?? null,
    hardMaxAmountCents: row.hardMaxAmountCents ?? null,
    dailyCapCents: row.dailyCapCents ?? null,
    allowedRecipients: stringArrayColumn(row.allowedRecipients, row.id, "allowed_recipients"),
    requiresApproval: row.requiresApproval === 1,
  };
}

/**
 * An http policy keeps its rules in `config`.
 *
 * A missing or unparseable config throws rather than defaulting. The host
 * allowlist is the only thing bounding an outbound call, so "no config" must
 * never quietly become "no restrictions" — the failure has to be loud and at
 * the point of reading, not silent and at the point of execution.
 */
function toHttpPolicy(row: PolicyRow): Policy {
  if (row.config === null) {
    throw new Error(`policy ${row.id}: an http policy requires a config, and this row has none`);
  }

  const parsed: unknown = JSON.parse(row.config);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`policy ${row.id}: config is not a JSON object`);
  }
  const config = parsed as Record<string, unknown>;

  const list = (key: string): string[] => {
    const value = config[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`policy ${row.id}: config.${key} is not a JSON array of strings`);
    }
    return value as string[];
  };

  /**
   * For keys whose absence is a real answer rather than a mistake.
   *
   * `allowedHosts` uses `list` because a missing allowlist must never become
   * "no restrictions". `classifyMethods` is the opposite case: every policy
   * written before the classifier existed lacks it, and the safe reading of
   * "not mentioned" is the empty list — nothing opened to a model. A present
   * but malformed value still throws, because that is a mistake.
   */
  const optionalList = (key: string): string[] =>
    config[key] === undefined || config[key] === null ? [] : list(key);

  const maxCallsPerDay = config["maxCallsPerDay"];
  if (
    maxCallsPerDay !== null &&
    maxCallsPerDay !== undefined &&
    (typeof maxCallsPerDay !== "number" || !Number.isInteger(maxCallsPerDay))
  ) {
    throw new Error(`policy ${row.id}: config.maxCallsPerDay must be an integer or null`);
  }

  return {
    actionType: "http",
    // Lowercased on the way in so the comparison against a parsed hostname,
    // which is always lowercase, cannot miss on case alone.
    allowedHosts: list("allowedHosts").map((host) => host.toLowerCase()),
    approvalMethods: list("approvalMethods"),
    deniedMethods: list("deniedMethods"),
    classifyMethods: optionalList("classifyMethods"),
    maxCallsPerDay: (maxCallsPerDay as number | undefined) ?? null,
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
/**
 * How many actions of one type have already executed today.
 *
 * The http equivalent of the spend total: there is no amount to add up, so
 * what a daily cap bounds is the number of calls. Counts executed actions
 * only, on the same reasoning — a request that was denied or is still waiting
 * on a person has not used anything up.
 */
export function countExecutedTodayByType(db: Db, projectId: string, actionType: string): number {
  const row = db
    .select({ total: sql<number>`count(*)` })
    .from(actions)
    .where(
      and(
        eq(actions.projectId, projectId),
        eq(actions.type, actionType),
        eq(actions.status, "executed"),
        gte(actions.createdAt, utcMidnightIso()),
      ),
    )
    .get();
  return Number(row?.total ?? 0);
}

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

// --- approvals --------------------------------------------------------------

export interface NewApproval {
  id?: string;
  actionId: string;
  /** sha256 hex. The plaintext token must never reach this function. */
  tokenHash: string;
  expiresAt: string;
}

export function insertApproval(db: Db, a: NewApproval): ApprovalRow {
  const [row] = db
    .insert(approvals)
    .values({
      id: a.id ?? newId("apr"),
      actionId: a.actionId,
      tokenHash: a.tokenHash,
      expiresAt: a.expiresAt,
      createdAt: now(),
    })
    .returning()
    .all();
  return row!;
}

export function getApprovalByTokenHash(db: Db, tokenHash: string): ApprovalRow | null {
  return db.select().from(approvals).where(eq(approvals.tokenHash, tokenHash)).get() ?? null;
}

export function getApprovalByActionId(db: Db, actionId: string): ApprovalRow | null {
  return db.select().from(approvals).where(eq(approvals.actionId, actionId)).get() ?? null;
}

export function listApprovals(db: Db): ApprovalRow[] {
  return db.select().from(approvals).all();
}

/**
 * Marks a token spent. Conditional on `decided_at` still being null, so two
 * concurrent decisions cannot both win — the second updates zero rows and this
 * returns null.
 */
export function markApprovalRowDecided(
  db: Db,
  approvalId: string,
  decision: "approve" | "deny",
  decidedBy: string,
): ApprovalRow | null {
  const [row] = db
    .update(approvals)
    .set({ decision, decidedBy, decidedAt: now() })
    .where(and(eq(approvals.id, approvalId), isNull(approvals.decidedAt)))
    .returning()
    .all();
  return row ?? null;
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

/**
 * Ordered by `(created_at, rowid)`.
 *
 * SQLite routinely writes several audit events inside the same millisecond, so
 * `created_at` alone is not a total order. The tiebreak has to be *insertion*
 * order, and `id` cannot provide it — ids are random nanoids, so tying on them
 * returns a stable but arbitrary sequence, which is how a trail ends up
 * reading `action.executed` before `action.executing`.
 *
 * SQLite's implicit `rowid` increments per insert, and this table is
 * append-only (no DELETE, so no rowid reuse), which makes it exactly the
 * monotonic counter needed here.
 */
export function listAudit(db: Db, actionId: string): AuditRow[] {
  return db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.actionId, actionId))
    .orderBy(auditEvents.createdAt, sql`rowid`)
    .all();
}

/**
 * Project-wide feed, newest first, with keyset pagination.
 *
 * The cursor is an event id rather than an offset. Offsets skip or repeat rows
 * when the table is written to between pages, which for an append-only log is
 * every page.
 */
export function listProjectAudit(
  db: Db,
  projectId: string,
  opts: { limit: number; cursor?: string | undefined },
): { events: AuditRow[]; nextCursor: string | null } {
  let before: number | null = null;
  if (opts.cursor) {
    const anchor = db
      .select({ seq: sql<number>`rowid` })
      .from(auditEvents)
      .where(and(eq(auditEvents.id, opts.cursor), eq(auditEvents.projectId, projectId)))
      .get();
    // An unknown cursor yields an empty page rather than the first page, so a
    // stale client cannot silently restart from the top.
    if (!anchor) return { events: [], nextCursor: null };
    before = anchor.seq;
  }

  const rows = db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.projectId, projectId),
        before === null ? undefined : sql`rowid < ${before}`,
      ),
    )
    .orderBy(desc(auditEvents.createdAt), sql`rowid desc`)
    // One extra row tells us whether another page exists without a count query.
    .limit(opts.limit + 1)
    .all();

  const events = rows.slice(0, opts.limit);
  const nextCursor = rows.length > opts.limit ? (events.at(-1)?.id ?? null) : null;
  return { events, nextCursor };
}

// --- site visits ------------------------------------------------------------

export interface VisitCounts {
  total: number;
  today: number;
}

/**
 * Record one visit and return the counts.
 *
 * The unique index on (day, visitor_hash) does the deduplication: a repeat
 * visitor on the same UTC day is a no-op insert, not a second row. That is why
 * `INSERT OR IGNORE` is correct here rather than a read-then-write, which would
 * race between two requests arriving together.
 */
export function recordVisit(db: Db, visitorHash: string, at: Date = new Date()): VisitCounts {
  const day = at.toISOString().slice(0, 10);
  db.insert(siteVisits)
    .values({
      id: newId("vis"),
      day,
      visitorHash,
      createdAt: at.toISOString(),
    })
    .onConflictDoNothing()
    .run();
  return getVisitCounts(db, at);
}

export function getVisitCounts(db: Db, at: Date = new Date()): VisitCounts {
  const day = at.toISOString().slice(0, 10);
  const total = db
    .select({ n: sql<number>`count(*)` })
    .from(siteVisits)
    .get();
  const today = db
    .select({ n: sql<number>`count(*)` })
    .from(siteVisits)
    .where(eq(siteVisits.day, day))
    .get();
  return { total: Number(total?.n ?? 0), today: Number(today?.n ?? 0) };
}

// --- users, sessions, oauth (the dashboard) ---------------------------------

export interface NewUser {
  githubId: string;
  login: string;
  email?: string | null;
  avatarUrl?: string | null;
}

export function getUserByGithubId(db: Db, githubId: string): UserRow | null {
  return db.select().from(users).where(eq(users.githubId, githubId)).get() ?? null;
}

export function getUser(db: Db, id: string): UserRow | null {
  return db.select().from(users).where(eq(users.id, id)).get() ?? null;
}

/**
 * Creates the user on first sign-in, refreshes the profile after that.
 *
 * Matched on the GitHub numeric id, never the login: a login can be given up
 * and claimed by somebody else, and matching on it would hand that person the
 * original account's projects.
 */
export function upsertUserFromGithub(db: Db, u: NewUser): UserRow {
  const at = now();
  const existing = getUserByGithubId(db, u.githubId);

  if (existing) {
    const [row] = db
      .update(users)
      .set({
        login: u.login,
        email: u.email ?? null,
        avatarUrl: u.avatarUrl ?? null,
        lastLoginAt: at,
      })
      .where(eq(users.id, existing.id))
      .returning()
      .all();
    return row!;
  }

  const [row] = db
    .insert(users)
    .values({
      id: newId("usr"),
      githubId: u.githubId,
      login: u.login,
      email: u.email ?? null,
      avatarUrl: u.avatarUrl ?? null,
      createdAt: at,
      lastLoginAt: at,
    })
    .returning()
    .all();
  return row!;
}

export function insertSession(
  db: Db,
  s: { userId: string; tokenHash: string; expiresAt: string },
): SessionRow {
  const [row] = db
    .insert(sessions)
    .values({
      id: newId("ses"),
      userId: s.userId,
      tokenHash: s.tokenHash,
      expiresAt: s.expiresAt,
      createdAt: now(),
    })
    .returning()
    .all();
  return row!;
}

export function getSessionByTokenHash(db: Db, tokenHash: string): SessionRow | null {
  return db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get() ?? null;
}

/** Signing out. Idempotent: revoking an already-revoked session is a no-op. */
export function revokeSession(db: Db, id: string): void {
  db.update(sessions)
    .set({ revokedAt: now() })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
    .run();
}

export function insertOauthState(
  db: Db,
  s: { stateHash: string; expiresAt: string },
): OauthStateRow {
  const [row] = db
    .insert(oauthStates)
    .values({
      id: newId("oas"),
      stateHash: s.stateHash,
      expiresAt: s.expiresAt,
      createdAt: now(),
    })
    .returning()
    .all();
  return row!;
}

/**
 * Spends an OAuth state, returning it only if it was unspent and unexpired.
 *
 * The update carries the `used_at IS NULL` predicate rather than reading then
 * writing, so two callbacks arriving with the same state cannot both pass —
 * SQLite settles it, not a race between two reads.
 */
export function consumeOauthState(db: Db, stateHash: string): OauthStateRow | null {
  const at = now();
  const [row] = db
    .update(oauthStates)
    .set({ usedAt: at })
    .where(
      and(
        eq(oauthStates.stateHash, stateHash),
        isNull(oauthStates.usedAt),
        gte(oauthStates.expiresAt, at),
      ),
    )
    .returning()
    .all();
  return row ?? null;
}

/** Housekeeping. Spent and stale states are of no further use. */
export function deleteExpiredOauthStates(db: Db): void {
  db.delete(oauthStates).where(lt(oauthStates.expiresAt, now())).run();
}

// --- dashboard reads --------------------------------------------------------

/** Newest first. Bounded, because the dashboard renders every row it gets. */
export function listActionsByProject(db: Db, projectId: string, limit = 50): ActionRecord[] {
  return db
    .select()
    .from(actions)
    .where(eq(actions.projectId, projectId))
    .orderBy(desc(actions.createdAt))
    .limit(limit)
    .all()
    .map(toActionRecord);
}

export function countActionsByStatus(db: Db, projectId: string, status: ActionStatus): number {
  const [row] = db
    .select({ n: sql<number>`count(*)` })
    .from(actions)
    .where(and(eq(actions.projectId, projectId), eq(actions.status, status)))
    .all();
  return row?.n ?? 0;
}

/** Same UTC-day boundary the policy engine uses, for the same reason. */
export function countActionsByStatusToday(
  db: Db,
  projectId: string,
  status: ActionStatus,
): number {
  const [row] = db
    .select({ n: sql<number>`count(*)` })
    .from(actions)
    .where(
      and(
        eq(actions.projectId, projectId),
        eq(actions.status, status),
        gte(actions.createdAt, utcMidnightIso()),
      ),
    )
    .all();
  return row?.n ?? 0;
}

export interface ClassifierVerdict {
  actionId: string;
  verdict: string;
  reason: string;
  model: string;
}

/**
 * The classifier's verdict for each of the given actions, where there was one.
 *
 * Read from the audit trail rather than stored on the action, because the trail
 * is already the record of who decided what and duplicating it invites the two
 * to disagree.
 */
export function classifierVerdictsFor(db: Db, actionIds: string[]): Map<string, ClassifierVerdict> {
  const found = new Map<string, ClassifierVerdict>();
  if (actionIds.length === 0) return found;

  const rows = db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.event, "action.classified"), inArray(auditEvents.actionId, actionIds)))
    .all();

  for (const row of rows) {
    if (!row.actionId || !row.data) continue;
    try {
      const data = JSON.parse(row.data) as { verdict?: unknown; reason?: unknown; model?: unknown };
      if (typeof data.verdict !== "string") continue;
      found.set(row.actionId, {
        actionId: row.actionId,
        verdict: data.verdict,
        reason: typeof data.reason === "string" ? data.reason : "",
        model: typeof data.model === "string" ? data.model : "unknown",
      });
    } catch {
      // A malformed audit row must not take the whole dashboard down.
    }
  }

  return found;
}

/**
 * Replaces one policy's config blob.
 *
 * Whole-object rather than a merge: the config is the fence for an action type,
 * and a partial write that silently kept an old key is how an allowlist ends up
 * containing something nobody remembers adding.
 */
export function updatePolicyConfig(
  db: Db,
  policyId: string,
  config: Record<string, unknown>,
): PolicyRow | null {
  const [row] = db
    .update(policies)
    .set({ config: JSON.stringify(config) })
    .where(eq(policies.id, policyId))
    .returning()
    .all();
  return row ?? null;
}
