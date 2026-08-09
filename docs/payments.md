# Payments (no processor attached)

**shipped.** [`src/backend/src/adapters/ledger.ts`](../src/backend/src/adapters/ledger.ts).

Adeia's product is the permission layer, not the processing. This deployment
runs with no payment processor: a payment is validated, evaluated against
policy, approved by a human if the policy says so, and then **recorded**. It
stops exactly where settlement would begin.

Everything the layer claims to do still happens. Nothing downstream of the
adapter does.

## Why there is no mock processor

The obvious alternative — an adapter that returns `pi_3QxK…` and `"succeeded"`
so the shape matches a real one — is worse than an empty seam, and deliberately
not what is here.

A record that looks like a settled charge is taken at face value by every later
reader: the audit trail, `sumSpentTodayCents`, a dashboard, a screenshot in a
deck, a person scrolling the table six months from now. Only whoever wired it up
knows it was theatre, and they will not be the last one to read it.

So the result says what actually happened:

```json
{
  "ledgerEntryId": "led_act_abc123",
  "status": "recorded",
  "settled": false,
  "amountCents": 2500,
  "currency": "usd",
  "recipient": "acct_cloudhost"
}
```

`settled` is `false` and is never anything else. `status` is `"recorded"`, not
`"succeeded"`. There is no `pi_` identifier anywhere, and
[a test asserts there never is](../tests/backend/adapters/ledger.test.ts).

The server says the same thing on stdout every boot:

```
[adeia] adapters: ledger
[adeia] NO PAYMENT PROCESSOR ATTACHED — payments are authorised and recorded;
[adeia]   no money moves. Register a processor adapter to change that.
```

A permission layer that has quietly stopped executing anything looks identical,
from the outside, to one that is working — the audit trail fills up either way.
The one thing that must never happen silently is nobody knowing which of the two
this is.

## What the adapter does

```ts
export function createLedgerAdapter(): Adapter {
  return {
    type: "payment",
    name: "ledger",
    async execute(rawParams, ctx) {
      const p = PaymentParamsSchema.parse(rawParams);
      return {
        ledgerEntryId: `led_${ctx.actionId}`,
        status: "recorded",
        settled: false,
        amountCents: p.amountCents,
        currency: p.currency,
        recipient: p.recipient,
      };
    },
  };
}
```

**It re-validates its params** with `PaymentParamsSchema` rather than trusting
its caller, exactly as a processor adapter must. The absence of a processor is
not a reason to be laxer than the thing that replaces it — this adapter is the
rehearsal for that one.

**It is reached only through the `approved → executing` transition.** There is
no path from `pending_approval` to an adapter, which is what makes "the agent
cannot spend while a human is still deciding" a structural property rather than
a promise. See [status-machine.md](status-machine.md).

**The action still lands in `executed`** and its amount still counts toward
[the daily cap](policy.md#the-daily-cap). The policy fence is exercised for
real; only settlement is absent.

## Attaching a processor

The [`Adapter`](../src/backend/src/adapters/types.ts) interface is the seam, and
it is the same seam a second processor would use later. Three steps:

1. Write `adapters/<processor>.ts` returning an `Adapter` with `type: "payment"`
   and its own `name`. Take the client as a constructor argument so it can be
   tested against a stub.
2. Add whatever credential it needs to [`env.ts`](../src/backend/src/env.ts),
   with a `require…()` guard called from `boot()`. If the processor
   distinguishes test from live credentials, **enforce the test prefix on
   environment parse**, not at charge time — the check is worth nothing if it
   runs after the request.
3. Swap the registration in [`server.ts`](../src/backend/src/server.ts):
   `createRegistry([createLedgerAdapter()])` becomes the new adapter, and the
   "no processor attached" banner comes out with it.

Nothing in `actions/service.ts`, the policy engine, the approval flow, or the
audit log changes. That is the point of the seam.

## Two idempotency guards, one attached

| Guard | Catches | Status |
|---|---|---|
| `UNIQUE(project_id, idempotency_key)` in SQLite | A duplicate **before the adapter is reached** | Active |
| The processor's own idempotency key | A duplicate that got past the first | Absent — nothing on the other end |

`idempotencyKey` is still carried on
[`AdapterContext`](../src/backend/src/adapters/types.ts) and still passed to the
adapter, so the second guard is a constructor argument away rather than a
refactor. Note that processors typically expire idempotency keys after ~24h and
scope them per account; the SDK generates a fresh UUID per logical action, so
that only bites a caller supplying their own long-lived key.

## Errors

An adapter that throws sets the action `failed` and records
`err.code ?? err.message` into `actions.error` — the code, when present, is what
a builder can branch on, so it is preferred over the prose message.

An adapter failure is never an HTTP 500. See [api.md](api.md#post-v1actions).

The ledger adapter itself only fails on invalid params, which means the `failed`
path is currently exercised by tests rather than by production traffic. Wire a
processor and it becomes the path a declined card takes.

## Testing

```bash
npx vitest run tests/backend/adapters
```

No network, no account, no credentials. The whole suite is offline — there is
nothing left in it that needs a third-party key.

**End to end:**

```bash
npm run seed
npm run dev
curl -X POST localhost:3000/v1/actions \
  -H "authorization: Bearer $ADEIA_API_KEY" -H "content-type: application/json" \
  -d @docs/json/examples/request-under-limit.json
```

Then read the trail with `npm run audit -- <actionId>`. Re-send the identical
body and confirm the same action id comes back and no second entry is recorded.

## Known limits

- **Nothing settles.** Worth restating: this deployment cannot move money, and
  is not a step away from being able to. Attaching a processor is the step.
- **Zero-decimal currencies.** JPY and KRW have no minor unit, so `amountCents`
  is a misnomer for them and the value would be off by 100×. Out of scope —
  noted so nobody "fixes" the USD maths to accommodate it.
- **No refunds, no captures, no webhooks.** No processor state to reconcile with
  yet; the omission becomes real the moment there is one.
- **One processor per deployment** when there is one. Credentials are
  process-wide, not per-project.
