# Database schema

**shipped.** SQLite via `better-sqlite3`, migrated with `drizzle-kit`. All five
tables landed in Phase 1; later phases add columns, not tables.

Source of truth: [`src/backend/src/db/schema.ts`](../src/backend/src/db/schema.ts).
Generated migration: [`src/backend/drizzle/`](../src/backend/drizzle/).

```bash
npm run db:generate    # after editing schema.ts
```

Conventions across every table:

- Ids are prefixed: `proj_`, `pol_`, `act_`, `apr_`, `evt_`, each with 21
  lowercase-alphanumeric characters of nanoid after the underscore.
- Timestamps are ISO-8601 UTC strings, so lexicographic ordering is chronological
  ordering.
- Columns marked `(json)` are JSON in a `text` column.
- Money is `integer` cents. There is no float column anywhere.
- `PRAGMA foreign_keys = ON` is set on every connection; WAL is on for
  file-backed databases and off for `:memory:`.

---

## `projects`

One API key, one fence.

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `proj_…` |
| `name` | text not null | Human label |
| `api_key_hash` | text not null unique | sha256 hex. The key itself is never stored |
| `created_at` | text not null | |

The plaintext key exists exactly once, in the output of `npm run seed`. There is
no rotation in the MVP — rotating means re-seeding the project.

## `policies`

The fence itself. One row per action type per project.

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `pol_…` |
| `project_id` | text not null → `projects.id` | |
| `action_type` | text not null | `payment` |
| `max_amount_cents` | integer | Above this → `require_approval`. `null` = no limit |
| `hard_max_amount_cents` | integer | Above this → `deny`. `null` = no ceiling |
| `daily_cap_cents` | integer | `spent + amount` above this → `deny`. `null` = no cap |
| `allowed_recipients` | text (json) | `string[]` or `null`. `null` = any recipient |
| `requires_approval` | integer not null | 0/1. Forces approval regardless of amount |
| `created_at` | text not null | |

`UNIQUE(project_id, action_type)`

**`null` and `0` are not the same value here.** `null` means *no limit*; `0`
means *nothing is allowed*. `toPolicy()` preserves the distinction and
`evaluate()` compares `!== null` explicitly — a truthiness check would treat a
`0` limit as absent and silently allow everything it was meant to stop.

## `actions`

Every request an agent has made, and what became of it.

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `act_…` |
| `project_id` | text not null → `projects.id` | |
| `type` | text not null | |
| `params` | text (json) not null | The validated request params |
| `status` | text not null | See [status-machine.md](status-machine.md) |
| `decision` | text | `allow` · `require_approval` · `deny` |
| `decision_reason` | text | Always names the number that triggered it |
| `idempotency_key` | text not null | |
| `result` | text (json) | Adapter output |
| `error` | text | Adapter error code |
| `created_at` | text not null | |
| `decided_at` | text | |
| `executed_at` | text | |

`UNIQUE(project_id, idempotency_key)` · `INDEX(project_id, status, created_at)`

The unique index is the first of two independent idempotency guards. It catches
a duplicate before any network call happens. Stripe's own idempotency key
(Phase 4) catches one that got past it. They fail differently, so both stay.

Note that `currency` is not a column — it lives inside `params`, and
`sumSpentTodayCents` reaches it with `json_extract(params, '$.currency')`. The
consequence is that **the daily cap is per-currency and nothing is ever
converted**: a project with USD and EUR payments has two independent caps. That
is a documented MVP limitation, not a bug.

## `approvals`

One human decision, one single-use token.

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `apr_…` |
| `action_id` | text not null → `actions.id` | |
| `token_hash` | text not null unique | sha256 hex. The plaintext token is **never** stored |
| `expires_at` | text not null | Default 24h, `APPROVAL_TOKEN_TTL_MS` |
| `decision` | text | `approve` · `deny` |
| `decided_at` | text | Non-null means the token is spent |
| `decided_by` | text | |
| `created_at` | text not null | |

Storing only the hash means a database leak yields no usable approval links.
Single use is enforced at decision time rather than render time, because both a
double-clicked button and a browser POST-resubmit reach the server twice.

## `audit_events`

Append-only. No `UPDATE`, no `DELETE` — a wrong record is corrected by appending
another event.

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `evt_…` |
| `action_id` | text → `actions.id` | Nullable: some events are project-level |
| `project_id` | text not null → `projects.id` | |
| `event` | text not null | See [audit-events.md](audit-events.md) |
| `data` | text (json) | Redacted at write time from Phase 6 |
| `created_at` | text not null | |

`INDEX(action_id, created_at)`

Reads sort by `(created_at, id)`, not `created_at` alone. SQLite routinely writes
several events inside the same millisecond, and the tiebreak on `id` is what
keeps a trail in stable order across reads.

---

## Queries worth knowing

All in [`src/backend/src/db/repo.ts`](../src/backend/src/db/repo.ts).

**`sumSpentTodayCents(db, projectId, currency)`** — money actually spent today.
Counts only `status = 'executed'` rows (a pending or denied action has moved
nothing), filters on currency, and bounds on `created_at >= ` **UTC** midnight.
Local midnight would shift the cap by the timezone offset and make the same
demo behave differently in the afternoon.

**`findActionByIdempotencyKey(db, projectId, key)`** — returns the original
record for a repeated key. Scoped per project, so two projects can use the same
key string without collision.

**`toPolicy(row)`** — maps a stored row into the shape `evaluate()` takes: JSON
parsed, `0`/`1` coerced to boolean, absent limits left as `null`. Throws on an
`allowed_recipients` column that is not a JSON array of strings.
