# Approvals

**shipped.** [`approvals/token.ts`](../src/backend/src/approvals/token.ts),
[`approvals/page.ts`](../src/backend/src/approvals/page.ts),
[`routes/approvals.ts`](../src/backend/src/routes/approvals.ts),
[`notify/email.ts`](../src/backend/src/notify/email.ts).

This is the half of the product a human touches. An action the policy engine
returns `require_approval` for pauses, emails someone, and waits — and executes
only after a person deliberately says yes.

It is also the part with the most ways to go quietly wrong, so most of this page
is about what is deliberately *not* done.

## Approval is never a GET

```
GET  /approvals/:token    renders the decision page. Mutates nothing.
POST /approvals/:token    records the decision and acts on it.
```

If the decision happened on `GET`, every payment would approve itself the moment
the email was delivered. This is not hypothetical — all of the following issue
unattended GET requests against links found in email:

- corporate mail security scanners, which follow every link to check it
- Slack, iMessage, WhatsApp and Teams link unfurlers
- browser and OS link prefetching
- anything that renders a preview

The email therefore contains one plain link to a page. The page holds two
`<form method="POST">` buttons. There is no URL anywhere that encodes a
decision, and a test asserts the email body never contains one.

The GET handler is inert in the ordinary case, and there is a test that fires
five prefetches at a live token and asserts the action is still
`pending_approval` with the adapter at zero calls.

**One exception, and why it is safe.** A GET against an *expired* token does
finalise the action to `expired`. That transition is only reachable after the
deadline has already passed, it is idempotent, and it strictly removes the
ability to act. A prefetcher hitting a dead link only finishes killing it. The
alternative — leaving expired actions in `pending_approval` — hangs the SDK's
`waitForAction` on every ignored email.

## The token

| Property | |
|---|---|
| Size | 32 bytes from `crypto.randomBytes`, base64url |
| At rest | `sha256(token)` hex only — the plaintext is never stored |
| Comparison | `timingSafeEqual`, not `===` |
| Uses | Exactly one |
| Lifetime | `APPROVAL_TOKEN_TTL_MS`, default 24h |
| Transport | Email only. Never logged, not even when sending fails |

The plaintext is returned once, from `mintApprovalToken`, straight to the
sender. A test serialises the whole `approvals` table and asserts the token does
not appear in it: a leaked database must not be a set of live approve buttons.

Because the token *is* the credential, the approval routes are not API-key
authenticated. The page sets `referrer-policy: no-referrer` and
`x-robots-tag: noindex` and contains no outbound links, so the token in the path
has nowhere to leak to. It does still land in browser history — accepted for the
MVP, and the 24h expiry limits it.

## Two guards against double execution

Both are needed, because they catch different things.

| Guard | Where | Catches |
|---|---|---|
| Single-use token | `markApprovalRowDecided`, a conditional `UPDATE … WHERE decided_at IS NULL` | Two clicks, a POST-resubmit, two concurrent requests. Exactly one wins |
| `status === "approved"` | `executeApproved` in [`actions/service.ts`](../src/backend/src/actions/service.ts) | Anything that reached execution by another route |

Tested with a real race: two simultaneous approve POSTs against one token
produce one `200` and one `410`, with the adapter called exactly once.

## The flow

```
policy says require_approval
  → action.pending_approval
  → mint token, send email          approval.sent
  → human opens the link            (nothing happens)
  → human clicks Approve            approval.granted
      → action.executing → action.executed
    or clicks Deny                  approval.denied
      → action.denied, adapter never called
    or nobody decides               approval.expired
      → action.expired
```

Status transitions are performed by `approveAction`, `denyAction` and
`expireAction` in `actions/service.ts`, not by the route. The route decides
*whether*; the service performs the change and records it. That keeps
`actions/service.ts` the only writer of an action status transition.

## Escaping

`description` is written by a language model, is influenceable through whatever
the agent read, and is rendered in a human's browser on the way to authorising a
payment. Every interpolated value on the page and in the email goes through
`escapeHtml` — `& < > " '`.

Tests render an action described as `<script>alert(1)</script>` and a recipient
of `acct" onload="alert(1)` and assert neither survives as markup.

## Configuration

| Variable | |
|---|---|
| `RESEND_API_KEY` | Resend key |
| `APPROVAL_FROM_EMAIL` | Must be a **Resend-verified** sender. Verification is not instant |
| `APPROVER_EMAIL` | Where requests land. One approver per deployment |
| `PUBLIC_BASE_URL` | Must be publicly reachable |
| `APPROVAL_TOKEN_TTL_MS` | Default `86400000` (24h) |

The server refuses to boot without the first four. Booting without them gives
the worst failure available: actions pause correctly and then wait forever
because nobody was told, which looks exactly like a hung agent.

**`PUBLIC_BASE_URL` is the single most likely live-demo failure.** A `localhost`
link is useless on the phone the approver is holding, so development needs a
tunnel:

```bash
ngrok http 3000     # paste the https URL into PUBLIC_BASE_URL, restart the server
```

The tunnel URL changes on every ngrok restart. Miss that and every emailed link
points at a dead host.

## What happens when the email fails

The send failure is logged loudly and swallowed. The action is already correctly
`pending_approval`, and turning a mail-provider outage into a `500` would tell
the agent its request failed when the request in fact succeeded and is waiting.

The plaintext token is **not** logged, even on failure — it is a bearer
credential for releasing a payment. The consequence is that a failed send leaves
an action waiting with no way to reach it, and the recovery is to request it
again with a fresh idempotency key. Minting a replacement token for an existing
action is not built.

## Known limits

- **One approver per deployment.** `APPROVER_EMAIL` is process-wide.
  Per-project approvers need a `projects.approver_email` column.
- **`decided_by` is not a verified identity.** The token is the only
  authentication, so the recorded decider is the address the link was *sent* to,
  not proof of who clicked.
- **Email only.** `onApprovalNeeded` in `actions/service.ts` is the injection
  point where Slack or a webhook slots in without the service changing.
- **No resend, no reminder, no escalation.** One email, one token, one deadline.
