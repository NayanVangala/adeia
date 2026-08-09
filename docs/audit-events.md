# Audit events

**partly shipped.** The table, the append-only writer
([`src/backend/src/audit/log.ts`](../src/backend/src/audit/log.ts)), and **every
event in the vocabulary below** are written today. All four sequences are
asserted — the auto-executed, denied and failed paths in
[`tests/backend/actions/service.test.ts`](../tests/backend/actions/service.test.ts),
the approved and approval-denied paths in
[`tests/backend/approvals/routes.test.ts`](../tests/backend/approvals/routes.test.ts).

Still to come in Phase 6: the product surface — the event name narrows to a
union, `data` is redacted at write time, and the query API and CLI land.

The audit log is the answer to "what did the agent actually do, and who let it?"
It is the closing slide of the demo and the reason a builder can put this in
front of a compliance team.

## The vocabulary

Every event, who writes it, and what it carries. Nothing outside this list is a
valid event name.

| Event | Written by | `data` |
|---|---|---|
| `action.requested` | action service (P3) | `{ type, params }` |
| `policy.evaluated` | action service (P3) | `{ decision, reason, spentTodayCents, policyId }` |
| `action.denied` | action service (P3) | `{ reason }` |
| `action.pending_approval` | action service (P3) | `{ reason }` |
| `approval.sent` | notifier (P5) | `{ to, expiresAt }` |
| `approval.granted` | `approveAction` (P5) | `{ decidedBy }` |
| `approval.denied` | `denyAction` (P5) | `{ decidedBy }` |
| `approval.expired` | `expireAction` (P5) | `{ expiredAt }` |
| `action.executing` | action service (P3) | `{ adapter }` |
| `action.executed` | action service (P3) | `{ result }` |
| `action.failed` | action service (P3) | `{ error }` |

From Phase 6 the `event` parameter is typed as this union, so a typo like
`action.exectued` is a compile error rather than a silently broken trail.

## Sequences

Each terminal path produces exactly one of these. Phase 6 asserts them.

**Auto-executed** — inside the fence, no human involved:

```
action.requested → policy.evaluated → action.executing → action.executed
```

**Denied by policy** — note there is no `action.executing`, because the adapter
was never called:

```
action.requested → policy.evaluated → action.denied
```

**Approved by a human:**

```
action.requested → policy.evaluated → action.pending_approval
                 → approval.sent → approval.granted
                 → action.executing → action.executed
```

**Refused by a human** — again, no adapter:

```
action.requested → policy.evaluated → action.pending_approval
                 → approval.sent → approval.denied
```

## Rules

**Every state transition writes an event.** A status change with no
corresponding row is a bug. Phase 6 adds a completeness check that walks every
action and cross-references its terminal status against a terminal event, which
catches a transition someone added without an audit write.

**Append-only.** No `UPDATE`, no `DELETE`. A record that turns out to be wrong is
corrected by appending another event, not by editing history.

**Redaction runs at write time, not read time.** Phase 6's `redact()` strips keys
matching `/secret|key|token|password|authorization/i` before serialization.
Redacting on read would leave the secret sitting in the database file you might
hand to someone.

**Redaction is a denylist, and denylists leak.** It catches known key names. It
will not catch a secret embedded in a free-text `description`. The real defence
is not putting secrets in `data`; redaction is the backstop, not the plan.

**A failed audit write must never roll back a completed payment.** The money
already moved. Log the failure loudly and continue — losing the record is bad,
unwinding a real transaction over a logging error is worse.

**Ordering is `(created_at, rowid)`.** SQLite writes several events inside the
same millisecond routinely, so timestamps alone are not a total order. The
tiebreak must be insertion order — tying on the random `id` produces a stable
but arbitrary sequence, which shows up as `action.executed` appearing before
`action.executing`.

**`data` has a size cap.** A few KB, so an adapter returning a large object
cannot bloat the table.

## Reading a trail

Phase 6 ships `npm run audit -- <actionId>`:

```
act_abc123  payment  executed
  params  { amountCents: 50000, currency: 'usd', recipient: 'acct_contractor' }
  result  { ledgerEntryId: 'led_act_abc123', status: 'recorded', settled: false }

14:02:11  action.requested         { type: 'payment', params: {...} }
14:02:11  policy.evaluated         { decision: 'require_approval', reason: 'amount 50000 exceeds per-action limit 5000' }
14:02:11  action.pending_approval  { reason: 'amount 50000 exceeds per-action limit 5000' }
14:02:12  approval.sent            { to: 'you@example.com', expiresAt: '2026-08-09T14:02:12Z' }
14:03:47  approval.granted         { decidedBy: 'you@example.com' }
14:03:47  action.executing         { adapter: 'ledger' }
14:03:49  action.executed          { result: { ledgerEntryId: 'led_act_abc123', status: 'recorded', settled: false } }
```

The same data is available over HTTP at `GET /v1/actions/:id/audit`, scoped to
the calling project.
