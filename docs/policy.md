# Policy engine

**shipped.** [`src/backend/src/policy/evaluate.ts`](../src/backend/src/policy/evaluate.ts),
covered by [`tests/backend/policy/evaluate.test.ts`](../tests/backend/policy/evaluate.test.ts).

This is the core of the product: one pure function that turns a request, a
policy, and today's spend into a decision plus a reason a human can read.

```ts
evaluate({
  actionType: "payment",
  params: { amountCents: 50000, currency: "usd", recipient: "acct_contractor" },
  policy,
  spentTodayCents: 2500,
});
// → { decision: "require_approval",
//     reason: "amount 50000 exceeds per-action limit 5000" }
```

It does no I/O, holds no database handle, and never reads a clock. Today's spend
arrives as an argument. That is why the test suite needs no fixtures, no fake
timers, and can be exhaustive.

## The three decisions

| Decision | What happens next |
|---|---|
| `allow` | Executes immediately |
| `require_approval` | Pauses, emails a human, waits |
| `deny` | Refused outright. No human is asked |

## Evaluation order

The order is load-bearing, not incidental. **All deny rules run to completion
before any approval rule.**

| # | Rule | Decision | Fires when |
|---|---|---|---|
| 1 | No policy | `deny` | No policy row for this action type |
| 2 | Wrong action type | `deny` | The policy is for a different type |
| 3 | Hard maximum | `deny` | `amount > hardMaxAmountCents` |
| 4 | Daily cap | `deny` | `spentToday + amount > dailyCapCents` |
| 5 | Forced approval | `require_approval` | `requiresApproval` is true |
| 6 | Per-action limit | `require_approval` | `amount > maxAmountCents` |
| 7 | Recipient allowlist | `require_approval` | Recipient is not on the list |
| — | Nothing fired | `allow` | `"within policy"` |

**Why deny must beat require_approval.** If a $2,000,000 payment to an unknown
recipient came back as `require_approval`, it would land in a human's inbox
looking like every other approval request — and a tired person at the end of a
long day would click through a hard cap that exists precisely so they never have
to make that call. A hard maximum a human can approve past is not a hard
maximum. The ordering in the code is the enforcement.

## Boundaries are inclusive

Every comparison is `>`, never `>=`. An amount exactly equal to a limit passes
it.

| Limit | At the limit | One cent over |
|---|---|---|
| `maxAmountCents: 5000` | `allow` | `require_approval` |
| `hardMaxAmountCents: 100000` | passes the deny rule | `deny` |
| `dailyCapCents: 20000` with 19500 spent | 500 → `allow` | 501 → `deny` |

Both boundary cases have dedicated tests. An off-by-one here is a fence that is
one cent tighter than the number a customer configured.

## `null` is not `0`

| Value | Meaning |
|---|---|
| `null` | No limit of this kind |
| `0` | Nothing is allowed |

`if (policy.maxAmountCents)` treats `0` as absent, which turns "allow nothing"
into "allow everything" — the exact inversion you least want in a guardrail.
Every check compares `!== null` explicitly. An empty `allowedRecipients: []`
allows nobody; `allowedRecipients: null` allows anybody.

## The daily cap

Checked against `spentToday + amount`, never `spentToday` alone. Testing the
running total by itself lets one action blow straight through a cap it started
the day under.

`spentTodayCents` comes from `sumSpentTodayCents`, which counts only `executed`
rows, filters on currency, and bounds on UTC midnight. Two consequences:

- **Pending and denied actions do not count.** Nothing has moved.
- **The cap is per-currency and no conversion happens.** A project paying in USD
  and EUR has two independent caps. Documented, not a bug.

## Reason strings

Every reason names the number that triggered it.

```
amount 500000 exceeds hard maximum 100000
daily cap 20000 would be exceeded (19500 already spent today)
amount 50000 exceeds per-action limit 5000
recipient "acct_stranger" is not on the allowlist
```

`"denied"` with no figure is useless in an approval email and worse in an audit
trail — the human deciding needs to see which limit they are being asked to
override and by how much. A test asserts every numeric rule's reason contains a
digit.

## The seed policy

`npm run seed` installs this, and the numbers are load-bearing for the demo
(generated copy: [json/seed-policy.json](json/seed-policy.json)):

| Setting | Value | |
|---|---|---|
| `maxAmountCents` | 5 000 | $50 — above this, ask a human |
| `hardMaxAmountCents` | 100 000 | $1,000 — above this, refuse |
| `dailyCapCents` | 200 000 | $2,000 per currency per UTC day |
| `allowedRecipients` | `null` | any recipient |
| `requiresApproval` | `false` | |

Against the demo's two invoices: a $25 payment auto-executes; a $500 payment
exceeds the $50 per-action limit and pauses for approval.

**The daily cap has to stay above the largest payment in the demo.** Deny beats
require_approval, so a $200 cap would deny the $500 invoice outright and the
approval flow — the entire point of the demo — would never fire. Change one of
these four numbers and re-check the other three;
[`tests/backend/policy/seedPolicy.test.ts`](../tests/backend/policy/seedPolicy.test.ts)
pins the relationship.

Note the test fixture in `evaluate.test.ts` uses a deliberately tight $200 daily
cap so the cap rules are cheap to exercise. It is not the seed policy.
