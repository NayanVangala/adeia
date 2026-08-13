# Adeia

**Let an agent actually do things — inside a fence you set.**

Most agent frameworks stop at the suggestion. Your model decides a vendor should
be paid, writes a convincing paragraph about it, and then a human does the
actual work. The moment you wire the model up to something that can *act*, you
inherit a different problem: what stops it at 2am when it decides a $40,000
payment is reasonable?

Adeia is the layer in between. The agent asks; a policy you control decides;
anything over the line waits for a person. Everything that happens is recorded.

```ts
const action = await adeia.requestAction({
  type: "payment",
  params: { amountCents: 2500, currency: "usd", recipient: "acct_cloudhost" },
});

action.status; // "executed" — inside the fence, it just ran
```

Ask for ten times that, and the same call returns something different:

```ts
action.status;          // "pending_approval"
action.decisionReason;  // "amount 50000 exceeds per-action limit 5000"
```

An email goes to a human. The agent waits. Nothing has reached the payment
processor, and nothing will until somebody clicks Approve.

---

## The 60-second version

```bash
npm install                                  # Node ≥ 22
npm run seed                                 # prints an API key, once
export ADEIA_API_KEY=adeia_sk_...
npm run dev
```

Then, from your agent. **The SDK is not on npm yet** — it ships inside this
repository as a workspace, so `@adeia/sdk` resolves for anything under
`examples/`. The fastest way to start is to copy the demo agent and edit it:

```bash
cp -r examples/demo-agent examples/my-agent
```

```ts
import { AdeiaClient } from "@adeia/sdk";

const adeia = new AdeiaClient({ apiKey: process.env.ADEIA_API_KEY! });

const action = await adeia.requestAction({
  type: "payment",
  params: {
    amountCents: 50_000,      // integer cents, always
    currency: "usd",
    recipient: "acct_contractor",
    description: "Q3 design work",
  },
});

if (action.status === "pending_approval") {
  const final = await adeia.waitForAction(action.id);   // a human decides
  console.log(final.status);                            // executed | denied | expired
}
```

The server needs somewhere to send approval mail — a Gmail app password
(`SMTP_USER` + `SMTP_PASSWORD`) or a Resend key — and a publicly reachable
`PUBLIC_BASE_URL`. See [docs/demo.md](docs/demo.md) for the complete setup.

**No payment processor is attached.** Payments are authorised, recorded, and
stop where settlement would begin; the server says so on every boot. That is a
deliberate empty seam, not a mock — see [docs/payments.md](docs/payments.md) for
why, and for the three steps that fill it.

---

## The fence

A policy is a handful of numbers, set by a human, stored server-side where the
agent cannot reach them:

| Setting | Effect |
|---|---|
| `maxAmountCents` | Above this, ask a person |
| `hardMaxAmountCents` | Above this, refuse — **no human is asked** |
| `dailyCapCents` | Cumulative per day, per currency |
| `allowedRecipients` | Off the list, ask a person |
| `requiresApproval` | Ask every time, whatever the amount |

Every deny rule is evaluated before every approval rule. That ordering is the
point: a hard maximum a tired human can click through at the end of a long day
is not a hard maximum.

Every refusal names the number that caused it, because
`"denied"` is useless in an approval email and worse in an audit log.

---

## What a human sees

Over-limit actions produce an email with the amount, the recipient, and which
rule tripped. The link opens a page with two buttons.

**Opening the link approves nothing.** Mail scanners, Slack and iMessage
unfurlers, and browser prefetch all issue unattended GET requests against links
in email — so `GET` renders, and only `POST` decides. A payment that could
approve itself on delivery isn't an approval flow. The token is single-use,
expires, and is stored only as a hash.

---

## What you can prove afterwards

```
$ npm run audit -- act_abc123

act_abc123  payment  executed
  params  { amountCents: 50000, currency: 'usd', recipient: 'acct_contractor' }
  policy  amount 50000 exceeds per-action limit 5000
  result  { ledgerEntryId: 'led_act_abc123', status: 'recorded', settled: false }

14:02:11  action.requested         { type: 'payment', params: {...} }
14:02:11  policy.evaluated         { decision: 'require_approval', reason: '...' }
14:02:11  action.pending_approval  { reason: '...' }
14:02:12  approval.sent            { to: 'you@example.com', expiresAt: '...' }
14:03:47  approval.granted         { decidedBy: 'you@example.com' }
14:03:47  action.executing         { adapter: 'ledger' }
14:03:49  action.executed          { result: { ledgerEntryId: 'led_act_abc123', settled: false } }
```

Append-only, secret-free, and reachable over HTTP at
`GET /v1/actions/:id/audit`. Every state change writes an event — a status that
moved without a record is a bug, and there is a test that says so.

---

## Run the demo

An LLM with two invoices, one tool, and no payment credentials:

```bash
npm run demo
```

The $25 invoice executes. The $500 one stops, emails you, and waits. Approve it
and the agent picks up where it left off. Click-by-click runbook:
[docs/demo.md](docs/demo.md).

---

## Docs

| | |
|---|---|
| [docs/api.md](docs/api.md) | Endpoints, status codes, error bodies |
| [docs/sdk.md](docs/sdk.md) | `@adeia/sdk` reference |
| [docs/policy.md](docs/policy.md) | How decisions are made, in order |
| [docs/approvals.md](docs/approvals.md) | Tokens, and why approval is never a GET |
| [docs/payments.md](docs/payments.md) | The ledger adapter, and how to attach a processor |
| [docs/audit-events.md](docs/audit-events.md) | The event vocabulary |
| [docs/schema.md](docs/schema.md) | Database schema |
| [docs/status-machine.md](docs/status-machine.md) | Action lifecycle |

---

## How it fits together

```
your agent ──▶ @adeia/sdk ──▶ POST /v1/actions
                                    │
                              policy engine        pure function, no I/O
                                    │
                   ┌────────────────┼────────────────┐
                 deny        require_approval      allow
                   │                │                │
                 refused        email a human    ┌────┘
                                    │            │
                              approve / deny ────┤
                                                 ▼
                                             adapter ──▶ (no processor attached)
```

Four rules hold the design together:

- `policy/evaluate.ts` takes everything as arguments — no database handle, no
  clock, no network. That is why its test suite can be exhaustive.
- `actions/service.ts` is the only module that writes an action status change.
- `adapters/*` is the only code that talks to a third party.
- `audit/log.ts` is the only writer of `audit_events`.

An adapter is reachable *only* through `approved → executing`. There is no edge
from `pending_approval` to an adapter, which is what makes "the agent cannot
spend while a human is deciding" a structural property rather than a promise.

---

## Status

Built for the Lumos Fellows program. Every layer above the adapter is real:
policy, approvals, audit, the SDK, the agent. The adapter seam is deliberately
empty — payments are authorised and recorded, nothing settles.

Known limits, named so they aren't mistaken for oversights: **no payment
processor attached**, **the SDK is not published to npm** (it ships in this
repo as a workspace), SQLite (no concurrent writers), email-only approvals, one
approver per deployment, no rate limiting on `POST /v1/actions`, no API key
rotation, and a daily cap that is per-currency and never converts.

There is no hosted Adeia. Running it means running the server yourself — the
API key comes from `npm run seed` on your own machine, and there is no signup,
no dashboard, and no key issuance for anyone else.
