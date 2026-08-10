# Adeia — reference docs

Adeia sits between an AI agent and the real world. The agent asks to *do*
something; Adeia decides whether that request is inside the fence its human set,
pauses for a human when it isn't, executes it when it is, and records the whole
trail either way.

These documents describe the system as built. The seven-phase build plan lives
in [`../CLAUDE.md`](../CLAUDE.md); this folder is the reference you read when you
want to know how a piece actually behaves.

## Contents

| Document | What it covers |
|---|---|
| [api.md](api.md) | HTTP surface — endpoints, status codes, error bodies, auth |
| [sdk.md](sdk.md) | `@adeia/sdk` — the client an agent builder actually installs |
| [payments.md](payments.md) | The ledger adapter, why there is no mock processor, and how to attach a real one |
| [approvals.md](approvals.md) | Tokens, the GET/POST split, and why approval is never a GET |
| [demo.md](demo.md) | Click-by-click runbook for the live demo |
| [schema.md](schema.md) | The five tables, every column, and why the constraints exist |
| [status-machine.md](status-machine.md) | Action lifecycle and the transitions that are legal |
| [policy.md](policy.md) | How `evaluate()` decides, in order, with the boundary rules |
| [audit-events.md](audit-events.md) | The event vocabulary and what each one carries |
| [json/](json/) | Machine-readable schemas and example payloads |

## Implementation status

Docs cover the whole design, so each section is tagged with where it stands.

| Tag | Meaning |
|---|---|
| **shipped** | Built, tested, and runnable today |
| **planned (Pn)** | Designed and specified; lands in phase *n* |

**All seven phases are shipped.** An agent requests an action, the policy engine
decides, an in-policy request executes, an over-limit one emails a human and
waits, a click on the decision page releases or refuses it, and the whole trail
is queryable over HTTP and readable from a CLI.

**No payment processor is attached.** Payments are authorised and recorded, and
stop where settlement would begin — deliberately, and loudly. See
[payments.md](payments.md) for what that does and does not mean, and for the
three steps that attach one.

The server needs one email transport — SMTP (a Gmail app password) or Resend —
and a publicly reachable `PUBLIC_BASE_URL` to start. See
[approvals.md](approvals.md). `npm run seed` and `npm run docs:json` need
neither.

## Generated files

Everything in [`json/`](json/) except `examples/` is generated from source:

```bash
npm run docs:json
```

`action-request.schema.json` and `payment-params.schema.json` come from the same
zod objects the API validates with. `seed-policy.json` comes from the same
`DEMO_POLICY` constant `npm run seed` writes to the database. A test asserts the
checked-in files match a fresh run, so a schema change that isn't regenerated
fails the suite instead of quietly shipping a document that lies.

## Conventions that hold everywhere

- **Money is integer cents.** No floats in the money path, anywhere. `currency`
  is a separate lowercase ISO-4217 string.
- **Timestamps are ISO-8601 UTC strings.** Including the daily-cap boundary,
  which is UTC midnight and not local midnight.
- **Secrets come from the environment only.** Never logged, never returned in a
  response, never written to the audit log.
- **Approval decisions are POST, never GET.** See
  [api.md](api.md#post-approvalstoken) for why this one is not a style
  preference.
