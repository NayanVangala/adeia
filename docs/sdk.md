# `@adeia/sdk`

**shipped.** [`src/sdk/src/index.ts`](../src/sdk/src/index.ts). This is what an
agent builder installs — the surface the customer of this product actually
touches.

```ts
import { AdeiaClient } from "@adeia/sdk";

const adeia = new AdeiaClient({
  apiKey: process.env.ADEIA_API_KEY!,
  baseUrl: process.env.ADEIA_URL,   // defaults to http://localhost:3000
});

const action = await adeia.requestAction({
  type: "payment",
  params: {
    amountCents: 2500,          // integer cents, never a float
    currency: "usd",
    recipient: "acct_cloudhost",
    description: "monthly hosting",
  },
});

if (action.status === "pending_approval") {
  const final = await adeia.waitForAction(action.id);
  console.log(final.status);    // executed | denied | expired | failed
}
```

No HTTP dependency — it is plain `fetch`.

## `new AdeiaClient(options)`

| Option | Required | Default | Notes |
|---|---|---|---|
| `apiKey` | yes | — | From `npm run seed` |
| `baseUrl` | no | `http://localhost:3000` | Trailing slashes are trimmed |
| `fetch` | no | global `fetch` | Injectable so tests need no live server |

## `requestAction(req)`

Resolves with the decided [`ActionRecord`](api.md#the-action-record) whatever the
outcome. **A policy denial is not an exception** — it comes back as a normal
record with `status: "denied"`. Only transport and request problems throw.

`idempotencyKey` is optional; the client generates a UUID per call when omitted.
Supply your own when you want a retry to be recognised as the same logical
action — a fresh key means a fresh payment.

```ts
await adeia.requestAction({
  type: "payment",
  idempotencyKey: `invoice-${invoice.id}`,   // stable across retries
  params: { amountCents: 50000, currency: "usd", recipient: "acct_contractor" },
});
```

**There is no automatic retry, deliberately.** A blind retry against a payment
endpoint is how double charges happen. The idempotency key makes a retry *safe*;
the decision to make one stays with you.

## `getAction(id)`

Fetches one action. Throws `AdeiaError` with `status: 404` for an unknown id —
and for another project's action, which is deliberately indistinguishable.

## `waitForAction(id, opts?)`

Polls until the action reaches a terminal status (`executed`, `failed`,
`denied`, `expired`).

| Option | Default | |
|---|---|---|
| `timeoutMs` | `300000` | Five minutes — long enough to click through an approval email, short enough not to hang an agent forever |
| `pollMs` | `2000` | |

Throws `AdeiaTimeoutError` (carrying `actionId` and `lastStatus`) if the deadline
passes while the action is still in flight. That is not a failure of the action —
a human may simply not have decided yet.

## Errors

```ts
import { AdeiaError, AdeiaTimeoutError } from "@adeia/sdk";
```

**`AdeiaError`** — any non-2xx response.

| Property | |
|---|---|
| `status` | HTTP status |
| `code` | Server's machine-readable code: `unauthorized`, `not_found`, `invalid_request`, `internal_error` |
| `issues` | Validation issue list, when the server sent one |

```ts
try {
  await adeia.requestAction(req);
} catch (err) {
  if (err instanceof AdeiaError && err.code === "invalid_request") {
    console.error(err.issues);
  }
}
```

**`AdeiaTimeoutError`** — `waitForAction` gave up. Carries `actionId` and
`lastStatus`.

## What the SDK does not do

- **It does not talk to Stripe.** The agent only ever sees this client. That
  separation is the entire pitch — the model cannot reach a payment processor
  even if it wants to.
- **It does not decide anything.** Every limit lives server-side in the policy,
  where the agent cannot edit it.
- **It does not retry.** See above.
