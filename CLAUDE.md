Project: Adeia — Agent Execution & Permissions Layer

One-liner

A layer that sits between an AI agent and the real world, letting the agent actually execute actions (payments, signups, multi-step tasks) instead of just suggesting them — within budgets the human sets, with a pause-and-approve step before anything consequential.

Positioning

Developer infrastructure. The customer is other builders shipping AI agents/products — they plug this in rather than building their own execution + guardrail layer from scratch. Not a consumer-facing app.

Context
Built for the Lumos Fellows 6-week program + builders competition.
Adjacent to an existing product (ActionLayer.io) — plan to be upfront about this with the Lumos rep, not treating it as fully original. Not a blocker for building.
Core Goals
Give agents hands — unified interface for an agent to execute real actions across services, not just output text a human has to act on.
Bound the agent's power — human sets budgets/limits upfront (spend caps, allowed action types, scope). Agent operates inside a fence.
Human-in-the-loop for consequential actions — approval mode pauses before sensitive actions (payment, email, anything hard to undo) and waits for explicit human sign-off.
Pluggable, not walled-garden — integrations for different services (payment processor, email, etc.) so it's not tied to one tool.

MVP Scope (6-week build)

One vertical, end-to-end. Primary candidate: payments via a sandbox/test-mode processor (e.g. Stripe test mode). Fallback if too heavy: email sending (Gmail/Resend API).

Core components
Agent-facing API/SDK — simple interface for an agent to request an action, e.g. requestAction({type: "payment", amount, recipient, ...}).
Policy engine — budget/limit rules (e.g. max $ per transaction, max $ per day, allowed recipients). Auto-executes if within bounds; flags if not.
Approval flow — action pauses when over-limit or marked sensitive; sends notification (pick one channel: Slack/email/SMS/webhook); waits for human approve/deny via link or simple UI.
One real integration — actually wired to the payment processor's sandbox (or email API) so the demo executes a real action, not a mock.
Audit log — record of every action requested/approved/denied/executed.
Explicitly out of scope for MVP (roadmap/vision language only, don't build)
Negotiating on the agent's behalf — too fuzzy to demo credibly in 6 weeks.
Multi-service orchestration — one integration working well beats several working shallowly.
Plugin marketplace / multiple processors — mention as vision only.
Demo script this scope supports

Agent requests a payment under the limit → auto-executes → agent requests a second, larger payment → pauses → human gets approval request → approves → action completes → audit log shows the full trail.

---

# Decisions (resolved 2026-08-04)

| Question | Decision | Why |
|---|---|---|
| First integration | **Stripe test mode** (PaymentIntent) | Budget/spend-cap policy only tells a compelling story with money. Real API call, visible in the Stripe dashboard. |
| Notification channel | **Email + approval page** (Resend) | No tunnel-dependent Slack app, no per-workspace install. One `PUBLIC_BASE_URL` and it works. |
| Demo agent | **Toy agent, Claude API tool-use, `claude-haiku-4-5`** | Full control, no framework debt. Haiku is ~$1/$5 per MTok — a hundred demo runs costs a few dollars. |
| Stack | **TypeScript / Node** | The customer (agent builders) is on TS. SDK ships as an npm package; types double as docs. |
| Name | **Adeia** | Greek: permission, license to act. |

## Revised 2026-08-09 — Stripe removed, no processor attached

**Phase 4 is reverted and its dependency, adapter, env var and tests are gone
from the repo.** Not deferred in place; removed. `npm run dev` needs no payment
credentials and the suite is fully offline.

Why: a Stripe account needs an adult account owner, and chasing one for a
fellowship project was not worth it. Test mode was never the issue — it moves no
money — but the signup is gated regardless.

What replaced it: [`adapters/ledger.ts`](src/backend/src/adapters/ledger.ts).
Payments are validated, evaluated, approved, and **recorded** — `status:
"recorded"`, `settled: false`, no `pi_` identifier. It does not imitate a
processor, and a test asserts it never starts to. The boot banner says
`NO PAYMENT PROCESSOR ATTACHED` on every start.

**Phase 4 below is left intact as written.** It is the spec for putting a
processor back, and the removal was built to make that a three-step change —
write the adapter, add its guarded env var, swap one line in `server.ts`. See
[docs/payments.md](docs/payments.md#attaching-a-processor).

The `Adapter` interface, `AdapterContext.idempotencyKey`, the
`approved → executing` sole path, and every policy rule are unchanged. Only the
thing on the far side of the seam is missing.

---

# Tech Stack (all phases)

| Concern | Choice | Introduced |
|---|---|---|
| Runtime | Node ≥ 22 (dev on 25.x), ESM (`"type": "module"`) | P1 |
| Language | TypeScript 5.x, `strict: true` | P1 |
| Running TS | `node --experimental-strip-types` (no build step in dev) | P1 |
| HTTP | `hono` + `@hono/node-server` | P1 |
| DB | `better-sqlite3` | P1 |
| ORM / migrations | `drizzle-orm` + `drizzle-kit` | P1 |
| Validation | `zod` | P1 |
| IDs | `nanoid` (prefixed: `proj_`, `act_`, `pol_`, `apr_`, `evt_`) | P1 |
| Tests | `vitest` | P1 |
| Payments | ~~`stripe`~~ — removed 2026-08-09. No processor; `adapters/ledger.ts` records without settling | ~~P4~~ |
| Email | `resend` | P5 |
| Demo agent | `@anthropic-ai/sdk`, model `claude-haiku-4-5` | P7 |
| Tunnel (demo only) | `ngrok` or `cloudflared` | P5 |

Deliberately **not** used: no Docker (SQLite file), no Redis (no queue in MVP), no React (approval page is server-rendered HTML), no auth provider (API keys are hashed rows).

## Global constraints

These hold in every phase. Violating one is a bug regardless of which phase introduced the code.

- **All money is integer cents.** No floats in the money path anywhere. `currency` is a separate ISO-4217 lowercase string. The single float→cents conversion in the whole system is in the demo agent (Phase 7), because the model talks in dollars.
- Secrets come from env only. Never logged, never returned in an API response, never written to the audit log.
- **No adapter may claim an outcome it did not produce.** The current payment adapter settles nothing, so it reports `status: "recorded"` and `settled: false` rather than borrowing a processor's success vocabulary. When a processor is attached, its test-credential prefix is enforced on environment *parse*, not at charge time.
- **Approval decisions are POST only.** Never GET. See Phase 5 edge cases — this is the single most likely way to ship an auto-approving payment system.
- Every action state transition writes an `audit_events` row. A status change with no audit row is a bug.
- Timestamps are ISO-8601 UTC strings.
- Commit after each phase step. Conventional prefixes (`feat:`, `test:`, `fix:`, `chore:`).

---

# Repo Structure

Package roots are independent — each has its own `package.json` and runs from its own directory. Root `package.json` holds npm workspaces and cross-package scripts only. No source files at repo root.

```
adeia/
├── package.json                     # workspaces + scripts only
├── tsconfig.base.json
├── README.md
├── config/
│   └── .env.example
├── src/
│   ├── shared/                      # @adeia/shared — types used by backend AND sdk
│   │   ├── package.json
│   │   └── src/
│   │       ├── actions.ts           # ActionStatus, Decision, ActionRequestSchema, ActionRecord
│   │       └── payment.ts           # PaymentParamsSchema
│   ├── backend/                     # @adeia/server
│   │   ├── package.json
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── server.ts            # Hono app assembly + boot
│   │       ├── env.ts               # Zod-validated env loader
│   │       ├── ids.ts               # prefixed id generator
│   │       ├── db/
│   │       │   ├── schema.ts        # Drizzle tables
│   │       │   ├── client.ts        # createDb() + migrate()
│   │       │   └── repo.ts          # all typed queries
│   │       ├── auth/
│   │       │   └── apiKey.ts        # hash, verify, middleware
│   │       ├── policy/
│   │       │   └── evaluate.ts      # PURE. no I/O. the core of the product.
│   │       ├── actions/
│   │       │   └── service.ts       # the ONLY writer of action status transitions
│   │       ├── adapters/
│   │       │   ├── types.ts         # Adapter interface + registry
│   │       │   └── ledger.ts        # records the payment, settles nothing
│   │       ├── approvals/
│   │       │   ├── token.ts         # mint + verify (hashed at rest)
│   │       │   └── page.ts          # server-rendered HTML
│   │       ├── notify/
│   │       │   └── email.ts         # Resend sender + template
│   │       ├── audit/
│   │       │   └── log.ts           # append-only writer + redaction
│   │       └── routes/
│   │           ├── actions.ts
│   │           ├── approvals.ts
│   │           └── audit.ts
│   └── sdk/                         # @adeia/sdk — what builders install
│       ├── package.json
│       └── src/
│           ├── index.ts             # AdeiaClient
│           └── errors.ts
├── examples/
│   └── demo-agent/
│       ├── package.json
│       └── src/agent.ts
├── scripts/
│   ├── seed.ts
│   └── audit.ts
└── tests/                           # mirrors src/ exactly
    ├── shared/
    ├── backend/{db,policy,actions,adapters,approvals,auth,routes,audit}/
    └── sdk/
```

Architectural rules the layout encodes:

- `policy/evaluate.ts` takes everything it needs as arguments. No DB handle, no clock, no network. This is why the policy suite can be exhaustive.
- `actions/service.ts` is the only module that writes an action status transition.
- `adapters/*` is the only place that talks to a third-party API.
- `audit/log.ts` is the only writer of `audit_events`.

---

# Environment Variables

Each phase unlocks the next requirement. Nothing before Phase 4 needs a third-party account — Phases 1–3 run fully offline.

| Variable | Required from | Example / notes |
|---|---|---|
| `NODE_ENV` | P1 | `development` |
| `PORT` | P1 | `3000` |
| `ADEIA_DB_PATH` | P1 | `./adeia.db` (`:memory:` in tests) |
| ~~`STRIPE_SECRET_KEY`~~ | — | Removed 2026-08-09. No payment credential is read anywhere |
| `RESEND_API_KEY` | **P5** | `re_…` |
| `APPROVAL_FROM_EMAIL` | P5 | Must be a Resend-verified sender |
| `APPROVER_EMAIL` | P5 | Where approval requests go |
| `PUBLIC_BASE_URL` | P5 | Must be publicly reachable — tunnel URL in dev |
| `APPROVAL_TOKEN_TTL_MS` | P5 | Default `86400000` (24h) |
| `ANTHROPIC_API_KEY` | **P7** | Demo agent only. Server never calls the model. |
| `ADEIA_API_KEY` | P3 (client side) | Printed once by `npm run seed` |
| `ADEIA_URL` | P3 (client side) | `http://localhost:3000` |

`config/.env.example` carries every key with a comment naming the phase that needs it.

---

# Phases

Each phase is a working, testable slice. Build it, run its test plan, confirm, then move on. Each phase below is written to stand alone — you can hand it over cold without re-reading the rest of the doc.

## Phase 1 — Core infra

**Goal:** A booting Hono server with a migrated SQLite database, API-key auth, and a `GET /v1/actions/:id` that returns a hand-seeded action row scoped to the calling project.

### Data models

All five tables land here. Later phases add columns but no new tables.

```ts
// src/backend/src/db/schema.ts
projects
  id             text pk           // proj_<nanoid>
  name           text not null
  api_key_hash   text not null unique   // sha256 hex of the plaintext key
  created_at     text not null

policies
  id                    text pk    // pol_<nanoid>
  project_id            text not null → projects.id
  action_type           text not null          // "payment"
  max_amount_cents      integer                // above → require_approval. null = no limit
  hard_max_amount_cents integer                // above → deny outright
  daily_cap_cents       integer                // spent+amount above → deny
  allowed_recipients    text (json)            // string[] | null. null = any
  requires_approval     integer not null       // 0/1. force approval always
  created_at            text not null
  UNIQUE(project_id, action_type)

actions
  id               text pk         // act_<nanoid>
  project_id       text not null → projects.id
  type             text not null
  params           text (json) not null
  status           text not null
  decision         text                        // allow | require_approval | deny
  decision_reason  text
  idempotency_key  text not null
  result           text (json)
  error            text
  created_at       text not null
  decided_at       text
  executed_at      text
  UNIQUE(project_id, idempotency_key)
  INDEX(project_id, status, created_at)

approvals
  id          text pk               // apr_<nanoid>
  action_id   text not null → actions.id
  token_hash  text not null unique  // sha256 hex. plaintext token NEVER stored
  expires_at  text not null
  decision    text                  // approve | deny
  decided_at  text
  decided_by  text
  created_at  text not null

audit_events
  id          text pk               // evt_<nanoid>
  action_id   text → actions.id
  project_id  text not null → projects.id
  event       text not null
  data        text (json)
  created_at  text not null
  INDEX(action_id, created_at)
```

Status machine — the only legal transitions:

```
pending_policy ─┬─> denied                                  (terminal)
                ├─> approved ──> executing ─┬─> executed    (terminal)
                │                           └─> failed      (terminal)
                └─> pending_approval ─┬─> approved ──> executing ──> …
                                      ├─> denied            (terminal)
                                      └─> expired           (terminal)
```

> **On the audit table landing in Phase 1:** the table and a minimal `appendAudit()` helper ship here because it is a data model, and because retrofitting event writes into six phases of already-written state transitions is strictly worse than writing them as you go. Phase 6 is the audit *product* — query API, redaction, CLI, completeness guarantees. Phases 2–5 each write their own events as they build.

### Key functions & endpoints

```ts
// db/client.ts
export function createDb(path: string): Db;
export function migrate(db: Db): void;

// ids.ts
export function newId(prefix: "proj" | "act" | "pol" | "apr" | "evt"): string;

// db/repo.ts
export function insertProject(db: Db, p: NewProject): Project;
export function getProjectByKeyHash(db: Db, hash: string): Project | null;
export function insertAction(db: Db, a: NewAction): ActionRecord;
export function getAction(db: Db, id: string): ActionRecord | null;
export function updateActionStatus(db: Db, id: string, patch: StatusPatch): ActionRecord;
export function findActionByIdempotencyKey(db: Db, projectId: string, key: string): ActionRecord | null;
export function sumSpentTodayCents(db: Db, projectId: string, currency: string): number;
export function getPolicy(db: Db, projectId: string, actionType: string): PolicyRow | null;

// audit/log.ts
export function appendAudit(db: Db, e: { actionId?: string; projectId: string; event: string; data?: unknown }): void;

// auth/apiKey.ts
export function hashApiKey(plaintext: string): string;             // sha256 hex
export function generateApiKey(): string;                          // adeia_sk_<32B base64url>
export const apiKeyAuth: MiddlewareHandler;                        // sets c.set("projectId", id)

// server.ts
export function createApp(deps: AppDeps): Hono;
```

Routes: `GET /healthz` (no auth) and `GET /v1/actions/:id` (auth, project-scoped).

### Build order

1. `git init`, root `package.json` with workspaces, `tsconfig.base.json`, `.gitignore` (`node_modules/`, `dist/`, `.env`, `*.db`, `*.db-journal`).
2. `src/shared` package: `ActionStatus`, `Decision`, `PaymentParamsSchema`, `ActionRequestSchema`, `ActionRecord`.
3. `src/backend` package. `env.ts` (Zod over `process.env`), `ids.ts`.
4. `db/schema.ts`, `db/client.ts`, generate migration with `drizzle-kit`.
5. `db/repo.ts` — the functions above. `sumSpentTodayCents` filters `status='executed' AND currency=? AND created_at >= <UTC midnight>`.
6. `audit/log.ts` — append-only.
7. `auth/apiKey.ts` — generate, hash, and the Hono middleware.
8. `server.ts` + `routes/actions.ts` with `GET /v1/actions/:id`.
9. `scripts/seed.ts` — create a project, print the plaintext key once, insert a demo policy (`max_amount_cents: 5000`, `hard_max_amount_cents: 100000`, `daily_cap_cents: 200000`, `allowed_recipients: null`, `requires_approval: 0`). These specific numbers are what make the Phase 7 demo work: $25 auto-executes, $500 exceeds the $50 per-action limit and pauses.

   **The daily cap must sit above the demo's largest payment.** Deny beats require_approval (Phase 2), so a $2,000 cap with a $500 invoice pauses correctly, while a $200 cap would deny it outright and the approval flow would never fire. If you change one of these numbers, re-check the other three.

### Test plan

Automated — `npx vitest run tests/backend/db tests/backend/auth tests/shared`:

- `ActionRequestSchema` rejects `amountCents: 25.5` (fractional) and accepts `2500`.
- `sumSpentTodayCents` counts only `status='executed'` rows in the matching currency. Seed one executed USD 1000, one denied USD 9999, one executed EUR 500 → expect `1000`.
- `findActionByIdempotencyKey` returns the original row for a repeated key.
- Inserting two actions with the same `(project_id, idempotency_key)` throws a unique-constraint error.
- `hashApiKey` output never equals its input; `getProjectByKeyHash(hashApiKey(k))` round-trips.

Manual:

```bash
npm run seed          # prints: adeia_sk_xxxxx  — copy it
npm run dev
curl localhost:3000/healthz
# → {"ok":true}
curl localhost:3000/v1/actions/act_fake
# → 401 {"error":"unauthorized"}
curl -H "authorization: Bearer adeia_sk_xxxxx" localhost:3000/v1/actions/act_fake
# → 404 {"error":"not_found"}
```

Then hand-insert an action row via `sqlite3 adeia.db` and confirm `GET` with the right key returns it, and `GET` with a *second* project's key returns **404, not 403**.

### Edge cases and failure modes

- **404 not 403 for cross-project reads.** A 403 confirms the ID exists. Both are "you can't have this" — return the one that leaks nothing.
- **`better-sqlite3` is a native module.** On Node 25 it may need a rebuild (`npm rebuild better-sqlite3`). Sort this on day one, not at demo time.
- **`__dirname` does not exist in ESM.** Derive from `import.meta.url` for migration file paths.
- **UTC midnight, not local.** `sumSpentTodayCents` must use UTC or the daily cap silently shifts by your timezone offset and the demo behaves differently in the afternoon.
- **Timing-safe key comparison.** Look the project up by hash, then confirm with `crypto.timingSafeEqual`. A plain `===` on the hash is a timing oracle.
- Store the API key hash, not the key. `seed.ts` prints the plaintext exactly once, with a warning that it will not be shown again.

---

## Phase 2 — Policy engine

**Goal:** A pure `evaluate()` function that turns an action request plus a policy plus today's spend into `allow` / `require_approval` / `deny` with a human-readable reason, covered by an exhaustive unit suite.

This is the product. No I/O means it can be tested exhaustively with zero fixtures.

### Data models

No new tables. Reads `policies` (Phase 1). Introduces the in-memory shape:

```ts
export interface Policy {
  actionType: string;
  maxAmountCents: number | null;       // above → require_approval
  hardMaxAmountCents: number | null;   // above → deny outright
  dailyCapCents: number | null;        // spent + amount above → deny
  allowedRecipients: string[] | null;  // null = any recipient
  requiresApproval: boolean;           // force approval regardless of amount
}
```

### Key functions

```ts
// policy/evaluate.ts
export interface PolicyInput {
  actionType: string;
  params: PaymentParams;      // { amountCents, currency, recipient, description? }
  policy: Policy | null;
  spentTodayCents: number;
}
export interface PolicyResult { decision: Decision; reason: string }

export function evaluate(input: PolicyInput): PolicyResult;

// db/repo.ts (add)
export function toPolicy(row: PolicyRow): Policy;   // json parse + null coercion
```

### Build order

1. Write the full test file first (below) and watch it fail.
2. Implement `evaluate` with deny rules first, approval rules second.
3. Add `toPolicy` to map the DB row (JSON string `allowed_recipients`, 0/1 `requires_approval`) into the clean `Policy` shape.

Evaluation order is load-bearing. All deny rules run to completion before any approval rule:

```ts
export function evaluate(input: PolicyInput): PolicyResult {
  const { actionType, params, policy, spentTodayCents } = input;

  // --- deny rules (run first, in this order) ---
  if (!policy) return { decision: "deny", reason: `no policy configured for action type "${actionType}"` };
  if (policy.actionType !== actionType)
    return { decision: "deny", reason: `policy is for "${policy.actionType}", not "${actionType}"` };
  if (policy.hardMaxAmountCents !== null && params.amountCents > policy.hardMaxAmountCents)
    return { decision: "deny", reason: `amount ${params.amountCents} exceeds hard maximum ${policy.hardMaxAmountCents}` };
  if (policy.dailyCapCents !== null && spentTodayCents + params.amountCents > policy.dailyCapCents)
    return { decision: "deny", reason: `daily cap ${policy.dailyCapCents} would be exceeded (${spentTodayCents} already spent today)` };

  // --- approval rules ---
  if (policy.requiresApproval)
    return { decision: "require_approval", reason: "policy requires approval for all actions of this type" };
  if (policy.maxAmountCents !== null && params.amountCents > policy.maxAmountCents)
    return { decision: "require_approval", reason: `amount ${params.amountCents} exceeds per-action limit ${policy.maxAmountCents}` };
  if (policy.allowedRecipients !== null && !policy.allowedRecipients.includes(params.recipient))
    return { decision: "require_approval", reason: `recipient "${params.recipient}" is not on the allowlist` };

  return { decision: "allow", reason: "within policy" };
}
```

### Test plan

`npx vitest run tests/backend/policy` — all of these against an explicit fixture policy (`max 5000`, `hardMax 100000`, `dailyCap 20000`, `allowedRecipients null`, `requiresApproval false`). Note this fixture uses a deliberately tight $200 daily cap so the cap rules are cheap to exercise; it is **not** the seed policy from Phase 1, whose cap is $2,000:

| Input | Expected |
|---|---|
| `amount 1000`, spent 0 | `allow` |
| `policy: null` | `deny`, reason matches `/no policy/i` |
| `amount 5001` | `require_approval` |
| `amount 5000` (boundary) | **`allow`** — the limit is inclusive |
| `amount 100001` | `deny` — hard max beats the approval rule |
| `amount 1000`, spent 19500 | `deny`, reason matches `/daily/i` |
| `amount 500`, spent 19500 (lands exactly on cap) | **`allow`** |
| `allowedRecipients: ["acct_known"]`, recipient `acct_demo` | `require_approval` |
| `requiresApproval: true`, amount 1000 | `require_approval` |
| `requiresApproval: true` + `allowlist` + `amount 100001` | **`deny`** — deny wins when both apply |
| `actionType: "email"` against a payment policy | `deny` |

Every reason string must name the number that triggered it. `"denied"` with no figure is useless in the demo audit trail.

### Edge cases and failure modes

- **Off-by-one on boundaries.** `>` not `>=` throughout. `amount === maxAmountCents` allows. Both boundary tests above exist specifically to pin this.
- **Deny must beat require_approval.** If a $2,000,000 payment to an unknown recipient came back as `require_approval`, a tired human could approve past the hard cap. The ordering in the code is the enforcement.
- **`null` vs `0`.** `maxAmountCents: null` means *no limit*; `0` means *nothing is allowed*. `if (policy.maxAmountCents)` treats `0` as absent — always compare `!== null` explicitly.
- **Daily cap is checked against `spentToday + amount`, not `spentToday`.** Checking the running total alone lets a single action blow straight through the cap.
- **Currency is not converted.** The daily cap is per-currency because `sumSpentTodayCents` filters by currency. Two currencies means two independent caps. Fine for the MVP — write it down so it isn't mistaken for a bug.
- Keep `evaluate` free of `Date.now()`. Today's spend arrives as an argument. The moment it reads a clock, the suite needs fake timers.

---

## Phase 3 — Agent-facing API and SDK

**Goal:** An agent can `POST /v1/actions` through the `@adeia/sdk` client and get back a decided action record, with a fake adapter standing in for execution — the full request path works end to end with no third-party account.

### Data models

No new tables. Introduces the adapter seam and the action service.

```ts
// adapters/types.ts
export interface AdapterContext { actionId: string; idempotencyKey: string }
export interface Adapter {
  type: string;
  execute(params: unknown, ctx: AdapterContext): Promise<Record<string, unknown>>;
}
export type AdapterRegistry = Map<string, Adapter>;
```

### Key functions & endpoints

```ts
// actions/service.ts
export interface RequestDeps {
  db: Db;
  adapters: AdapterRegistry;
  onApprovalNeeded: (actionId: string, projectId: string) => Promise<void>;  // no-op stub until P5
}
export function requestAction(deps: RequestDeps, projectId: string, req: ActionRequest): Promise<ActionRecord>;
export function executeApproved(deps: RequestDeps, actionId: string): Promise<ActionRecord>;

// sdk/src/index.ts
export class AdeiaClient {
  constructor(opts: { apiKey: string; baseUrl?: string; fetch?: typeof fetch });
  requestAction(req: ActionRequestInput): Promise<ActionRecord>;   // generates idempotencyKey if omitted
  getAction(id: string): Promise<ActionRecord>;
  waitForAction(id: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<ActionRecord>;
}
export class AdeiaError extends Error { status: number; code: string }
```

Endpoints:

| Method | Path | Response |
|---|---|---|
| `POST` | `/v1/actions` | `201` executed/failed · `202` pending_approval · `200` denied · `400` malformed |
| `GET` | `/v1/actions/:id` | `200` record · `404` unknown or other project |

A denial is `200`, not `4xx` — the API call succeeded and is reporting a policy outcome. An agent that treats a denial as a transport error will retry it forever.

### Build order

1. `adapters/types.ts` and a `FakeAdapter` test double that records calls and can be told to throw.
2. `actions/service.ts` — `requestAction`:
   1. `findActionByIdempotencyKey` → if found, return unchanged, **before any side effect**.
   2. Insert `status: "pending_policy"`; audit `action.requested`.
   3. Load policy + `sumSpentTodayCents`; `evaluate`; audit `policy.evaluated` with `{decision, reason}`.
   4. `deny` → status `denied`, audit `action.denied`, return.
   5. `require_approval` → status `pending_approval`, audit `action.pending_approval`, `await onApprovalNeeded(...)`, return.
   6. `allow` → status `approved`, fall through to the shared execute path.
3. Shared execute path (reused by `executeApproved` in Phase 5): status `executing` + audit → `adapter.execute()` → success: `executed` + `result` + audit; throw: `failed` + `error` message + audit. **Do not rethrow** — a failed action is a recorded outcome, not a 500.
4. `executeApproved` throws unless the current status is exactly `approved`. That guard is what makes a double-clicked approve button safe in Phase 5.
5. `POST /v1/actions` route: parse with `ActionRequestSchema`, map outcome → status code.
6. `src/sdk` package: plain `fetch`, no HTTP dependency. `fetch` is injectable purely so tests need no live server. `waitForAction` polls `getAction` until status ∈ `{executed, failed, denied, expired}`; defaults `timeoutMs: 300000`, `pollMs: 2000`.

### Test plan

`npx vitest run tests/backend/actions tests/backend/routes tests/sdk`:

- In-policy action → `status: "executed"`, fake adapter called once, `onApprovalNeeded` not called.
- Over-limit action → `status: "pending_approval"`, **adapter called zero times**, `onApprovalNeeded` called with `(actionId, projectId)`.
- Over-hard-max → `status: "denied"`, adapter called zero times.
- Same idempotency key twice → same `id` returned, adapter called **once**.
- Adapter throws `card_declined` → `status: "failed"`, `error` contains `card_declined`, no exception escapes.
- Audit events for the happy path, in order: `["action.requested", "policy.evaluated", "action.executing", "action.executed"]`.
- `executeApproved` on a `pending_approval` action rejects (not yet approved).
- Route: no key → 401; bad body → 400 with Zod issue detail; other project's action → 404.
- SDK: sends `authorization: Bearer <key>`; generates an idempotency key when omitted; throws `AdeiaError` carrying `status` on 4xx; `waitForAction` resolves when a stubbed fetch goes pending→pending→executed; rejects on timeout while still pending.

Manual — run the server with the fake adapter registered:

```bash
curl -X POST localhost:3000/v1/actions \
  -H "authorization: Bearer $ADEIA_API_KEY" -H "content-type: application/json" \
  -d '{"type":"payment","idempotencyKey":"k1","params":{"amountCents":2500,"currency":"usd","recipient":"acct_demo"}}'
# → 201 {"id":"act_...","status":"executed","decision":"allow","decisionReason":"within policy",...}

# same body again
# → 201 with the SAME id, and the fake adapter log still shows one call

curl … -d '{"type":"payment","idempotencyKey":"k2","params":{"amountCents":50000,"currency":"usd","recipient":"acct_demo"}}'
# → 202 {"status":"pending_approval","decisionReason":"amount 50000 exceeds per-action limit 5000",...}

curl … -d '{"type":"payment","idempotencyKey":"k3","params":{"amountCents":500000,"currency":"usd","recipient":"acct_demo"}}'
# → 200 {"status":"denied","decisionReason":"amount 500000 exceeds hard maximum 100000",...}
```

### Edge cases and failure modes

- **The idempotency check must come before every side effect**, including the audit write. Otherwise a retried request appends duplicate audit events for a single logical action.
- **A pending action must never touch the adapter.** This is the whole product claim. The "adapter called zero times" assertions are the ones that prove it — do not weaken them.
- **Adapter failure is not an HTTP error.** Returning a 500 on a declined card makes SDK callers retry a payment that already reached Stripe.
- **`onApprovalNeeded` is injected**, so Phases 3–4 need no email account and the tests never send mail. Phase 5 swaps the stub for the real sender without touching the service.
- **Do not let the SDK auto-retry on 5xx by default.** A blind retry on a payment endpoint is how double charges happen. The idempotency key makes retries *safe*, but the caller should opt in.
- Status codes carry meaning here — `202` specifically tells the SDK "this is not finished, poll it."

---

## Phase 4 — Payment integration (Stripe test mode)

> **Reverted 2026-08-09. Not in the repo.** Kept verbatim as the spec for
> attaching a processor later. What actually ships today is
> [`adapters/ledger.ts`](src/backend/src/adapters/ledger.ts) — no processor, no
> settlement. See the revision note under Decisions above.

**Goal:** Replace the fake adapter with a real Stripe adapter; an in-policy request through the SDK produces a succeeded PaymentIntent visible in the Stripe test dashboard.

### Data models

No new tables. Fixes the shape written into `actions.result`:

```ts
{ paymentIntentId: string; status: string; amountCents: number; currency: string }
```

### Key functions

```ts
// adapters/stripe.ts
export function createStripeAdapter(stripe: Stripe): Adapter;

// env.ts (add)
STRIPE_SECRET_KEY: z.string().startsWith("sk_test_", "live keys are refused")
```

### Tech stack

`stripe` (official Node SDK). Test-mode card token `pm_card_visa` — Stripe's built-in test payment method, no card data ever touches this codebase.

### Build order

1. `npm i -w src/backend stripe`.
2. Add `STRIPE_SECRET_KEY` to `env.ts` with the `sk_test_` guard. Boot fails loudly on a live key.
3. Implement the adapter:

```ts
export function createStripeAdapter(stripe: Stripe): Adapter {
  return {
    type: "payment",
    async execute(rawParams: unknown, ctx: AdapterContext) {
      const p = PaymentParamsSchema.parse(rawParams);
      const intent = await stripe.paymentIntents.create(
        {
          amount: p.amountCents,
          currency: p.currency,
          description: p.description,
          payment_method: "pm_card_visa",
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          metadata: { adeia_action_id: ctx.actionId, adeia_recipient: p.recipient },
        },
        { idempotencyKey: ctx.idempotencyKey },
      );
      return { paymentIntentId: intent.id, status: intent.status, amountCents: p.amountCents, currency: p.currency };
    },
  };
}
```

4. Register it in `server.ts` in place of the fake adapter.
5. Add `tests/backend/adapters/stripe.live.test.ts`, guarded by `describe.skipIf(!process.env.STRIPE_SECRET_KEY)`.

### Test plan

Unit — `npx vitest run tests/backend/adapters`, stubbed Stripe client, no network:

- `paymentIntents.create` receives `amount: 2500`, `confirm: true`, `metadata.adeia_action_id: "act_1"`, and options `{ idempotencyKey: "k1" }`.
- Returned result is `{ paymentIntentId: "pi_123", status: "succeeded", amountCents: 2500, currency: "usd" }`.
- `execute({ amountCents: -1 }, ctx)` rejects — the adapter re-validates rather than trusting its caller.

Live — run once by hand with a real test key:

```bash
STRIPE_SECRET_KEY=sk_test_… npx vitest run tests/backend/adapters/stripe.live.test.ts
```

Expect a real 100-cent PaymentIntent with `status: "succeeded"`.

Manual end-to-end:

```bash
npm run dev
curl -X POST localhost:3000/v1/actions -H "authorization: Bearer $ADEIA_API_KEY" \
  -H "content-type: application/json" \
  -d '{"type":"payment","idempotencyKey":"live-1","params":{"amountCents":2500,"currency":"usd","recipient":"acct_cloudhost","description":"monthly hosting"}}'
```

Then confirm in `dashboard.stripe.com/test/payments`: one $25.00 succeeded PaymentIntent, whose metadata carries the matching `adeia_action_id`. Re-send the identical body and confirm **no second PaymentIntent** appears.

### Edge cases and failure modes

- **Live key.** The `sk_test_` boot guard is the only thing between a demo and a real charge. Add it before the adapter, not after.
- **Two independent idempotency guards.** The DB unique index (Phase 1) and Stripe's own `idempotencyKey` fail differently — the DB catches an in-flight duplicate before any network call, Stripe catches one that got past it. Keep both.
- **Stripe idempotency keys expire after 24h** and are scoped per account. Long-lived retries after that window will create a second charge. Use a fresh UUID per logical action, which the SDK does by default.
- **`confirm: true` can return `requires_action`** (3DS) rather than `succeeded`. `pm_card_visa` does not trigger it, but do not assume `succeeded` — write `intent.status` through to the result and let the audit trail show it.
- **Zero-decimal currencies** (JPY, KRW) have no cents. `amountCents` is a misnomer for them. Out of scope for the demo; note it so nobody "fixes" USD math to accommodate it.
- **Stripe errors are typed.** `card_declined` is a `StripeCardError` with `.code`. Persist `err.code ?? err.message` into `actions.error` — the code is what a builder can branch on.
- Never log the Stripe key, and never put it in `metadata`.

---

## Phase 5 — Approval flow

**Goal:** An over-limit action emails a human, waits, and executes only after they click Approve on a POST-backed page; a denied or expired approval never reaches Stripe.

The security-critical phase. Read the edge cases before writing code.

### Data models

No new tables — `approvals` was created in Phase 1. Rules that govern it:

- Token is 32 bytes from `crypto.randomBytes`, base64url encoded.
- Only `sha256(token)` is stored. A database leak must not yield usable approval links.
- Single use — a row with `decided_at` set is rejected.
- Expiry — `APPROVAL_TOKEN_TTL_MS`, default 24h.

### Key functions & endpoints

```ts
// approvals/token.ts
export function mintApprovalToken(db: Db, actionId: string, ttlMs?: number): Promise<string>; // plaintext returned ONCE
export function verifyApprovalToken(db: Db, token: string): Promise<ApprovalRow>;             // throws on bad/used/expired
export function markApprovalDecided(db: Db, token: string, decision: "approve" | "deny", by: string): Promise<void>;

// approvals/page.ts
export function renderApprovalPage(action: ActionRecord, token: string): string;  // HTML, all values escaped
export function renderDecidedPage(decision: string): string;
export function renderExpiredPage(): string;

// notify/email.ts
export function sendApprovalEmail(opts: { to: string; action: ActionRecord; token: string }): Promise<void>;
```

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/approvals/:token` | Renders the decision page. **Mutates nothing.** |
| `POST` | `/approvals/:token` | Body `decision=approve\|deny`. Decides, then executes or denies. |

### Build order

1. `npm i -w src/backend resend`. Add `RESEND_API_KEY`, `APPROVAL_FROM_EMAIL`, `APPROVER_EMAIL`, `PUBLIC_BASE_URL`, `APPROVAL_TOKEN_TTL_MS` to `env.ts`.
2. `approvals/token.ts`:

```ts
const hash = (t: string) => createHash("sha256").update(t).digest();

export async function mintApprovalToken(db: Db, actionId: string, ttlMs = env.APPROVAL_TOKEN_TTL_MS) {
  const token = randomBytes(32).toString("base64url");
  await repo.insertApproval(db, {
    id: newId("apr"),
    actionId,
    tokenHash: hash(token).toString("hex"),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
  return token;   // returned once, to the email sender only
}
```

   `verifyApprovalToken` looks the row up by hex hash, re-confirms with `timingSafeEqual`, then checks `decided_at === null` and `expiresAt > now`. On expiry it also transitions the action to `expired` and audits it.
3. `approvals/page.ts` — plain server-rendered HTML string. **Escape every interpolated value** (`&<>"'`); `description` is agent-supplied and reaches a browser. Two `<form method="POST">` buttons. No JS, no external assets. Show amount, currency, recipient, description, policy reason, and requesting project — enough to decide without leaving the page.
4. `notify/email.ts` — Resend. Subject `Approval needed: $500.00 to acct_contractor`. Body states amount, recipient, reason, and one link to `${PUBLIC_BASE_URL}/approvals/${token}`. The link is a GET to the page; the page holds the POST buttons.
5. `routes/approvals.ts` — GET verifies then renders; POST verifies, `markApprovalDecided`, then approve → set action `approved` and call `executeApproved`, deny → set `denied`. Audit `approval.granted` / `approval.denied` with the decider. Used or expired token → `410` with an explanatory page.
6. Wire the real `onApprovalNeeded` in `server.ts`: `mintApprovalToken` → `sendApprovalEmail`. The Phase 3 stub disappears; `actions/service.ts` is unchanged.

### Test plan

`npx vitest run tests/backend/approvals`:

- `mintApprovalToken` — `JSON.stringify(allApprovalRows)` does **not** contain the plaintext token.
- Fresh token verifies and returns the right `actionId`.
- `ttlMs: -1` → verify rejects with `/expired/i`.
- After `markApprovalDecided` → verify rejects with `/already/i`.
- Garbage token → rejects.
- **GET renders the page and leaves `status === "pending_approval"` unchanged.** This is the prefetch-safety test.
- POST `decision=approve` → action `executed`, adapter called once.
- POST `decision=deny` → action `denied`, **adapter called zero times**.
- Second POST with the same token → `410`, adapter call count still exactly 1.
- Audit contains `approval.granted` with the decider recorded.
- Escaping: an action with `description: '<script>alert(1)</script>'` renders escaped — the raw string does not appear in the HTML.

Manual, with a tunnel running:

```bash
ngrok http 3000                 # copy the https URL into PUBLIC_BASE_URL
npm run dev
# request a $500 payment via curl → 202 pending_approval
```

1. Email arrives at `APPROVER_EMAIL` within seconds.
2. Open the link on a phone → decision page renders with the real amount.
3. `curl localhost:3000/v1/actions/<id>` → **still `pending_approval`**.
4. Click Approve → success page; action becomes `executed`; a second PaymentIntent appears in Stripe.
5. Reload the page → used-token page, `410`. No third PaymentIntent.

### Edge cases and failure modes

- **Never make approval a GET.** Corporate mail scanners, Slack/iMessage link unfurlers, and browser prefetch all issue GETs against links in email. A mutating GET auto-approves every payment the moment the mail is delivered — before a human has read it. Manual check 3 above exists solely to prove this cannot happen.
- **Store only the hash.** A leaked `approvals` table must not be a set of live approve buttons.
- **Single-use, enforced at decision time, not render time.** Both a double-clicked button and a browser POST-resubmit reach the server twice.
- **Two guards against double execution, and both are needed:** `markApprovalDecided` on the token, and `executeApproved`'s `status === "approved"` check on the action.
- **Escape the description.** It comes from an LLM, is attacker-influenceable through the agent's inputs, and lands in a human's browser.
- **Expired token must transition the action to `expired`**, not leave it dangling in `pending_approval` forever. The SDK's `waitForAction` polls for a terminal status — without this it hangs until its own timeout.
- **`PUBLIC_BASE_URL` must be publicly reachable.** A `localhost` link in an email is useless on a phone. The tunnel URL changes every `ngrok` restart — re-set the env var and restart the server, or the emailed links point at a dead host.
- **Resend requires a verified sender domain.** Get this done well before the demo; verification is not instant.
- **Email can be slow or land in spam.** Have `scripts/audit.ts` and a direct `curl` to the approval URL ready as a fallback path during the live demo.

---

## Phase 6 — Audit log

**Goal:** Every action exposes a complete, ordered, secret-free trail through both an API and a readable CLI, with a test proving no state transition can occur without a recorded event.

Phases 1–5 wrote audit events as they built. This phase turns those rows into the product surface: query, redaction, presentation, and a completeness guarantee.

### Data models

`audit_events` from Phase 1. This phase fixes the vocabulary — the complete set of events, and nothing outside it:

| Event | Written by | `data` |
|---|---|---|
| `action.requested` | P3 service | `{ type, params }` |
| `policy.evaluated` | P3 service | `{ decision, reason, spentTodayCents, policyId }` |
| `action.denied` | P3 service | `{ reason }` |
| `action.pending_approval` | P3 service | `{ reason }` |
| `approval.sent` | P5 notify | `{ to, expiresAt }` |
| `approval.granted` | P5 route | `{ decidedBy }` |
| `approval.denied` | P5 route | `{ decidedBy }` |
| `approval.expired` | P5 token | `{ expiredAt }` |
| `action.executing` | P3 service | `{ adapter }` |
| `action.executed` | P3 service | `{ result }` |
| `action.failed` | P3 service | `{ error }` |

### Key functions & endpoints

```ts
// audit/log.ts
export const AUDIT_EVENTS = [...] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];
export function appendAudit(db: Db, e: { actionId?: string; projectId: string; event: AuditEvent; data?: unknown }): void;
export function redact(data: unknown): unknown;   // strips keys matching /secret|key|token|password|authorization/i

// db/repo.ts (add)
export function listAudit(db: Db, actionId: string): AuditRow[];               // ordered by created_at, id
export function listProjectAudit(db: Db, projectId: string, opts: { limit: number; cursor?: string }): AuditRow[];
```

| Method | Path | Response |
|---|---|---|
| `GET` | `/v1/actions/:id/audit` | Ordered event list, project-scoped |
| `GET` | `/v1/audit?limit=&cursor=` | Project-wide feed, newest first |

CLI: `npm run audit -- <actionId>`.

### Build order

1. Narrow the `event` parameter to the `AuditEvent` union. The compiler now catches a typo'd event name — a `"action.exectued"` string breaks the demo trail silently otherwise.
2. Implement `redact` and call it inside `appendAudit` on every `data` payload before serialization.
3. `listAudit` / `listProjectAudit` in the repo, with a stable sort (`created_at, id` — several events can share a millisecond).
4. `routes/audit.ts`, project-scoped exactly like `GET /v1/actions/:id`.
5. `scripts/audit.ts` — print the action row, then each event as `HH:MM:SS  event  {data}`. This is on screen during the demo; make it readable at presentation font size.

### Test plan

`npx vitest run tests/backend/audit`:

- **Completeness.** Drive an action through each terminal path and assert the exact event sequence:
  - auto-execute: `["action.requested", "policy.evaluated", "action.executing", "action.executed"]`
  - denied: `["action.requested", "policy.evaluated", "action.denied"]`
  - approved: `["action.requested", "policy.evaluated", "action.pending_approval", "approval.sent", "approval.granted", "action.executing", "action.executed"]`
  - approval denied: `[..., "action.pending_approval", "approval.sent", "approval.denied"]`
- **No orphan transitions.** After running every service test, assert every action row's terminal status has a corresponding terminal event. A helper that walks all actions and cross-checks catches a transition someone added without an audit write.
- **Redaction.** `appendAudit(db, { …, data: { apiKey: "adeia_sk_secret", processorSecretKey: "psk_live_x", amountCents: 100 } })` → the stored row contains `amountCents` and does **not** contain `adeia_sk_secret` or `psk_live_x`.
- **Ordering** is stable when several events share a timestamp.
- **Scoping.** `GET /v1/actions/:id/audit` with another project's key → `404`.

Manual:

```bash
npm run audit -- act_abc123
```

Expected output for the $500 approved action:

```
act_abc123  payment  executed
  params  { amountCents: 50000, currency: 'usd', recipient: 'acct_contractor' }
  result  { ledgerEntryId: 'led_act_abc123', status: 'recorded', settled: false }

14:02:11  action.requested         { type: 'payment', params: {...} }
14:02:11  policy.evaluated         { decision: 'require_approval', reason: 'amount 50000 exceeds per-action limit 5000' }
14:02:11  action.pending_approval  { reason: 'amount 50000 exceeds per-action limit 5000' }
14:02:12  approval.sent            { to: 'you@example.com', expiresAt: '2026-08-05T14:02:12Z' }
14:03:47  approval.granted         { decidedBy: 'you@example.com' }
14:03:47  action.executing         { adapter: 'ledger' }
14:03:49  action.executed          { result: { ledgerEntryId: 'led_act_abc123', settled: false } }
```

That block is the demo's closing slide. Design the formatting for it.

### Edge cases and failure modes

- **The audit log is append-only.** No `UPDATE`, no `DELETE`. If a fix is needed, append a correcting event.
- **Redaction must run at write time**, not read time. Redacting on read leaves the secret sitting in the database file you might hand someone.
- **Redaction is a denylist and denylists leak.** It catches the known key names; it will not catch a secret embedded in a free-text `description`. The real defence is not putting secrets in `data` — redaction is the backstop.
- **Millisecond collisions.** SQLite writes several events inside the same millisecond routinely. Sorting by `created_at` alone shuffles the trail on every read; the tiebreak on `id` is what makes the demo output stable.
- **A failed audit write must not roll back a completed payment.** The money already moved. Log the failure loudly and continue — losing the record is bad, unwinding a real transaction over it is worse.
- **`data` is JSON in a text column.** Enforce a size cap (a few KB) so an adapter returning a huge object cannot bloat the table.

---

## Phase 7 — Demo polish

**Goal:** `npm run demo` reliably drives a Haiku 4.5 agent through the full script — auto-execute, pause, email, approve, resume — with the audit trail as the closer.

### Data models

None. Demo-side only.

### Key components

```ts
// examples/demo-agent/src/agent.ts
const payVendor = betaZodTool({
  name: "pay_vendor",
  description:
    "Pay a vendor. Amount is in whole dollars. Returns the outcome, which may be that a human " +
    "must approve the payment first — in that case this tool waits for their decision.",
  inputSchema: z.object({
    vendor: z.string().describe("Vendor account id, e.g. acct_cloudhost"),
    amountDollars: z.number().positive(),
    description: z.string(),
  }),
  run: async ({ vendor, amountDollars, description }) => { /* SDK call + wait */ },
});
```

### Tech stack

`@anthropic-ai/sdk`, `betaZodTool` from `@anthropic-ai/sdk/helpers/beta/zod`, `client.beta.messages.toolRunner`. Model **exactly** `claude-haiku-4-5`, `max_tokens: 4096`, non-streaming.

Send **no** `thinking` and **no** `output_config.effort` — Haiku 4.5 rejects `effort`.

### Build order

1. `npm i -w examples/demo-agent @anthropic-ai/sdk zod @adeia/sdk`.
2. Write the agent:

```ts
const adeia = new AdeiaClient({ apiKey: process.env.ADEIA_API_KEY!, baseUrl: process.env.ADEIA_URL! });
const anthropic = new Anthropic();

const payVendor = betaZodTool({
  name: "pay_vendor",
  description: "...",
  inputSchema: z.object({ vendor: z.string(), amountDollars: z.number().positive(), description: z.string() }),
  run: async ({ vendor, amountDollars, description }) => {
    const rec = await adeia.requestAction({
      type: "payment",
      idempotencyKey: randomUUID(),
      params: {
        amountCents: Math.round(amountDollars * 100),   // the ONLY float→cents boundary in the system
        currency: "usd",
        recipient: vendor,
        description,
      },
    });
    if (rec.status === "pending_approval") {
      console.log(`\n⏸  $${amountDollars} to ${vendor} needs human approval. Email sent. Waiting…\n`);
      const final = await adeia.waitForAction(rec.id, { timeoutMs: 300_000 });
      return `Action ${final.id}: ${final.status}. ${final.decisionReason ?? ""}`;
    }
    return `Action ${rec.id}: ${rec.status}. ${rec.decisionReason ?? ""}`;
  },
});

const final = await anthropic.beta.messages.toolRunner({
  model: "claude-haiku-4-5",
  max_tokens: 4096,
  tools: [payVendor],
  system:
    "You are an operations agent that settles vendor invoices. Pay each invoice you are given, " +
    "one tool call at a time. Report the outcome of each payment plainly, including any that " +
    "required human approval or were refused by policy.",
  messages: [{
    role: "user",
    content:
      "Settle these invoices:\n" +
      "1. acct_cloudhost — $25.00 — monthly hosting\n" +
      "2. acct_contractor — $500.00 — Q3 design work",
  }],
});
```

3. Root scripts:

```json
{
  "test": "vitest run",
  "dev": "node --experimental-strip-types src/backend/src/server.ts",
  "seed": "node --experimental-strip-types scripts/seed.ts",
  "audit": "node --experimental-strip-types scripts/audit.ts",
  "demo": "npm run -w examples/demo-agent start"
}
```

4. `README.md` — what Adeia is, a 60-second quickstart (install SDK, set a policy, request an action), the SDK surface. Written for the builder who is the customer, not for yourself.
5. `docs/demo.md` — the click-by-click runbook below, with env vars and the tunnel step. You will run this under time pressure; write it so it works read literally.

### Test plan

Full suite first: `npm test` → all green, nothing skipped. The suite is fully offline; no test needs a third-party credential.

Then the end-to-end, in order:

```bash
ngrok http 3000                 # paste https URL into PUBLIC_BASE_URL
npm run seed                    # copy printed key into ADEIA_API_KEY
npm run dev &
npm run demo
```

| # | Check | Expected |
|---|---|---|
| 1 | $25 invoice | Auto-executes. Agent reports it. Result carries `settled: false`. |
| 2 | $500 invoice | Agent prints the waiting message. Approval email arrives. |
| 3 | Open email link | Page renders. `GET /v1/actions/<id>` still shows `pending_approval`. **Prefetch safety.** |
| 4 | Click Approve | Executes. Agent resumes and reports both outcomes. |
| 5 | Reload approval page | Used-token page, `410`. The action stays `executed`, not run twice. |
| 6 | `npm run audit -- <id>` | Full trail: requested → policy.evaluated → pending_approval → approval.sent → approval.granted → executing → executed. |

Two `executed` actions after a full run. Not one, not three — `sqlite3 adeia.db "SELECT id, status FROM actions;"`.

Rehearse the whole sequence end to end at least twice before presenting.

### Edge cases and failure modes

- **Wrong model string.** `claude-haiku-4-5` exactly. No date suffix.
- **Do not send `effort` or `thinking` to Haiku 4.5** — `effort` errors outright.
- **The tunnel URL changes on every ngrok restart.** Update `PUBLIC_BASE_URL` and restart the server, or emailed links point at a dead host. This is the single most likely live-demo failure.
- **`waitForAction` default timeout is 5 minutes.** Long enough to click through an email on stage, short enough not to hang forever. Do not raise it into the demo silently.
- **The agent may pay in the wrong order or batch both calls.** The system prompt says "one tool call at a time" for exactly this reason. If ordering still wobbles, split into two user turns.
- **`Math.round(amountDollars * 100)`** is the one float boundary. `$0.29 * 100 === 28.999999999999996` — without the round, a payment is a cent short and the demo has a bug on screen.
- **Live email latency.** Have `npm run audit` and a direct approval URL ready as the fallback if the mail is slow.
- **Rate limits.** Haiku 4.5 has its own limits; a rehearsal loop can hit them. Rehearse well before the presentation, not five minutes prior.
- **Don't let the agent talk to whatever executes.** The model only sees the Adeia SDK. That separation is the pitch — never shortcut it for the demo.
- **Say "nothing settles" before you are asked.** No processor is attached, the boot banner says so, and the audit result reads `settled: false`. Volunteering it costs a sentence; being caught not volunteering it costs the room.

---

# Deferred (not in the MVP build)

Real gaps, named so they are not mistaken for oversights:

- **No payment processor.** The largest gap and the most visible one. Payments are authorised and recorded; nothing settles. Phase 4 above is the spec for reversing this, and [docs/payments.md](docs/payments.md#attaching-a-processor) is the three-step version. Blocked on an account, not on code.
- **SQLite → Postgres** once concurrent writers exist.
- **Approval channel is email only.** `onApprovalNeeded` in `actions/service.ts` is the injection point where Slack or a webhook slots in without touching the service.
- **No rate limiting on `POST /v1/actions`.** Required before any non-demo exposure.
- **One approver per deployment** (`APPROVER_EMAIL`). Per-project approvers need a `projects.approver_email` column.
- **No key rotation.** Rotating an API key means re-seeding the project.
- **Daily cap is per-currency and never converts.** Documented in Phase 2, not a bug.
- **A second adapter.** The `Adapter` interface existing is the pluggability story; a second implementation is not needed to demo it.
