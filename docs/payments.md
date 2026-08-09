# Payments (Stripe test mode)

**shipped.** [`src/backend/src/adapters/stripe.ts`](../src/backend/src/adapters/stripe.ts).

The Stripe adapter is the only code in the repo that talks to Stripe, and it is
reached only through the `approved → executing` transition. Nothing an agent
sends can shortcut it.

## The `sk_test_` guard

```
STRIPE_SECRET_KEY=sk_test_...
```

This one check is the whole distance between a rehearsal and a real charge
against a real card, so it is enforced in two places:

| Where | What it catches |
|---|---|
| Environment parse ([`env.ts`](../src/backend/src/env.ts)) | Any key not starting with `sk_test_`. Rejected the moment the environment is read — not on the first charge |
| `requireStripeSecretKey()` in `boot()` | A missing key. The server refuses to start |

Rejected outright: `sk_live_…`, `rk_live_…`, `rk_test_…`, `pk_test_…`,
`sk_TEST_…`, and anything with leading whitespace. Only an exact `sk_test_`
prefix passes.

**The server refuses to boot without a key rather than falling back to a fake
adapter.** A server that starts and quietly executes nothing produces a demo
that looks like it works and moves no money — a worse failure than not starting.

The key is required by `npm run dev` only. `npm run seed` and
`npm run docs:json` do not need a Stripe account.

## What gets sent

```ts
stripe.paymentIntents.create(
  {
    amount: p.amountCents,          // integer cents, straight through
    currency: p.currency,           // lowercase ISO-4217
    description: p.description,
    payment_method: "pm_card_visa", // Stripe's built-in test token
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: {
      adeia_action_id: ctx.actionId,
      adeia_recipient: p.recipient,
    },
  },
  { idempotencyKey: ctx.idempotencyKey },
);
```

**No card data ever touches this codebase.** `pm_card_visa` is a token that only
exists in Stripe test mode.

**`adeia_action_id` in metadata is the join back.** From any row in the Stripe
dashboard you can reach the audit trail that authorised it. Nothing secret goes
in metadata — it is readable by anyone with dashboard access.

**The adapter re-validates its params** with `PaymentParamsSchema` rather than
trusting its caller. It is the last boundary before money moves.

## What comes back

Written into `actions.result`:

```json
{
  "paymentIntentId": "pi_3QxK2mBlxYzAbCdE1fGhIjKl",
  "status": "succeeded",
  "amountCents": 2500,
  "currency": "usd"
}
```

`status` is Stripe's PaymentIntent status, **passed through verbatim and never
asserted to be `succeeded`**. `confirm: true` can return `requires_action` for a
card that needs 3DS. `pm_card_visa` does not trigger it, but recording
"succeeded" unconditionally would claim a payment completed when it had not.

One consequence worth knowing: an action whose intent came back
`requires_action` is still recorded as `executed`, so its amount counts toward
[the daily cap](policy.md#the-daily-cap) even though no money moved. That
over-counts spend, which tightens the fence rather than loosening it — it fails
in the safe direction. Reconciling intent status back into the cap is deferred.

## Two idempotency guards, both kept

| Guard | Catches |
|---|---|
| `UNIQUE(project_id, idempotency_key)` in SQLite | A duplicate **before any network call** |
| Stripe's `idempotencyKey` request option | A duplicate that got past the first |

They fail differently, which is why neither replaces the other.

**Stripe expires idempotency keys after 24 hours** and scopes them per account.
A retry after that window creates a second charge. The SDK generates a fresh
UUID per logical action, so this only bites a caller who supplies their own
long-lived key.

## Errors

Stripe errors are typed — `card_declined` arrives as a `StripeCardError` with a
`.code`. The adapter lets it propagate; the action service records
`err.code ?? err.message` into `actions.error` and sets the action `failed`. The
code is what a builder can branch on, so it is preferred over the prose message.

An adapter failure is never an HTTP 500. See
[api.md](api.md#post-v1actions).

## Testing

**Unit** — stubbed Stripe client, no network:

```bash
npx vitest run tests/backend/adapters/stripe.test.ts
```

**Live** — guarded by `describe.skipIf(!process.env.STRIPE_SECRET_KEY)`, so the
default suite stays offline and green on a machine with no Stripe account:

```bash
STRIPE_SECRET_KEY=sk_test_… npx vitest run tests/backend/adapters/stripe.live.test.ts
```

That creates real 100-cent PaymentIntents in test mode and asserts a repeated
idempotency key returns the same intent.

**End to end:**

```bash
npm run seed
npm run dev
curl -X POST localhost:3000/v1/actions \
  -H "authorization: Bearer $ADEIA_API_KEY" -H "content-type: application/json" \
  -d @docs/json/examples/request-under-limit.json
```

Then check `dashboard.stripe.com/test/payments`: one $25.00 succeeded
PaymentIntent whose metadata carries the matching `adeia_action_id`. Re-send the
identical body and confirm **no second PaymentIntent appears**.

## Known limits

- **Zero-decimal currencies.** JPY and KRW have no minor unit, so `amountCents`
  is a misnomer for them and the value would be off by 100×. Out of scope for
  the MVP — noted so nobody "fixes" the USD maths to accommodate it.
- **No refunds, no captures, no webhooks.** A PaymentIntent is created and
  confirmed in one call; nothing listens for later state changes.
- **One Stripe account per deployment.** The key is process-wide, not
  per-project.
