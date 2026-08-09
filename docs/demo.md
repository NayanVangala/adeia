# Demo runbook

Written to be followed literally under time pressure. Do the setup once, well
before you present; the run itself is five commands.

**What the audience sees:** an agent pays a $25 invoice on its own, tries to pay
a $500 one, stops, emails you, waits — you approve on your phone — and it
resumes and reports both outcomes. Then the audit trail.

---

## One-time setup

### 1. Accounts

| | Needed for | Watch out for |
|---|---|---|
| Stripe test key (`sk_test_…`) | Payments | Test mode only — the server refuses to boot on a live key |
| Resend account + **verified sender domain** | Approval email | **Verification is not instant. Do this days ahead.** |
| Anthropic API key | The demo agent only | The Adeia server never calls a model |

### 2. `.env` at the repo root

```bash
cp config/.env.example .env
```

Fill in:

```
STRIPE_SECRET_KEY=sk_test_...
RESEND_API_KEY=re_...
APPROVAL_FROM_EMAIL=approvals@yourdomain.com
APPROVER_EMAIL=you@example.com
PUBLIC_BASE_URL=            # left blank for now — see step 3 on the day
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Rehearse the whole sequence end to end, twice

Not once. The two things that break are the tunnel URL and email latency, and
both only show up in a full run.

---

## On the day

### 1. Start the tunnel

```bash
ngrok http 3000
```

Copy the `https://…` URL into `PUBLIC_BASE_URL` in `.env`.

> **This is the single most likely failure.** The tunnel URL changes on every
> ngrok restart. If you restart it, you must update `PUBLIC_BASE_URL` **and
> restart the server**, or every emailed link points at a dead host. A
> `localhost` URL is useless on the phone you're holding.

### 2. Seed

```bash
rm -f adeia.db adeia.db-wal adeia.db-shm     # fresh trail, no old actions on screen
npm run seed
```

Copy the printed key:

```bash
export ADEIA_API_KEY=adeia_sk_...
export ADEIA_URL=http://localhost:3000
```

The key is printed exactly once. Lose it and you re-seed.

### 3. Start the server

```bash
npm run dev
```

Expect three lines. If you don't see all three, stop and fix it — the server
refuses to start rather than run half-configured:

```
[adeia] listening on http://localhost:3000  (db: ./adeia.db)
[adeia] adapters: stripe  (stripe test mode)
[adeia] approvals: you@example.com via https://your-tunnel.ngrok-free.app
```

### 4. Open these before you start talking

- `dashboard.stripe.com/test/payments`
- Your email inbox, on your phone
- A spare terminal for `npm run audit`

### 5. Run it

```bash
npm run demo
```

---

## What should happen, in order

| # | Beat | Expected |
|---|---|---|
| 1 | Agent pays $25 | Auto-executes. A succeeded $25.00 PaymentIntent appears in the Stripe test dashboard. |
| 2 | Agent tries $500 | Prints `⏸ … needs human approval`, then waits. Email arrives within seconds. |
| 3 | **Open the link on your phone** | Page renders with the real amount. In the spare terminal, `curl localhost:3000/v1/actions/<id>` still shows `pending_approval`. **This is the prefetch-safety beat — say out loud that opening the link approved nothing.** |
| 4 | Tap Approve | Success page. Agent resumes and reports both invoices. A second PaymentIntent appears. |
| 5 | Reload the approval page | "Link no longer valid", HTTP 410. **No third PaymentIntent.** |
| 6 | `npm run audit -- <actionId>` | The full trail: requested → policy.evaluated → pending_approval → approval.sent → approval.granted → executing → executed. |

**Two PaymentIntents at the end. Not one, not three.**

---

## If something goes wrong

| Symptom | Cause | Do this |
|---|---|---|
| Server won't start, complains about `STRIPE_SECRET_KEY` | Missing or not `sk_test_` | Fix `.env`. It is refusing on purpose. |
| Server won't start, names `PUBLIC_BASE_URL` etc. | Approval flow unconfigured | Fill in the Resend block. |
| Email never arrives | Slow, spam, or unverified sender | **Don't wait on stage.** Use the fallback below. |
| Approval link 404s or hangs | Tunnel restarted; `PUBLIC_BASE_URL` is stale | Update `.env`, restart the server, re-run. |
| Agent hangs after the pause | Nobody approved within 5 minutes | `waitForAction` times out; the agent reports it as still waiting. |
| Agent pays in the wrong order | Model batched the calls | The system prompt says "one tool call at a time". If it still wobbles, split the invoices across two user turns. |
| `429` from Anthropic | Rehearsal loop hit Haiku's rate limit | Rehearse well before, not five minutes before. |

### Email fallback

Have this ready in a second terminal. It finds the pending action and its
approval URL without touching your inbox:

```bash
sqlite3 adeia.db \
  "SELECT a.id, 'PUBLIC_BASE_URL/approvals/<token>' FROM actions a WHERE a.status='pending_approval';"
```

The plaintext token is **not** recoverable from the database — only its hash is
stored, which is the point. If the email is genuinely lost, the recovery is to
re-run the demo rather than to fish a token out of storage. Say that out loud if
it happens; it demonstrates the security property rather than undermining it.

---

## The closing line

Pull up the audit trail and let it sit on screen:

```bash
npm run audit -- <the $500 action id>
```

Every decision, who made it, and when. The agent could not have raised its own
limit, could not have reached Stripe while the payment was waiting, and could
not have approved itself — not because it was told not to, but because there is
no code path that does it.

---

## Notes for questions you'll get

**"What if the model just calls Stripe directly?"** It has no Stripe key and no
Stripe tool. Its entire world is one `pay_vendor` function.

**"What if the model lies about the amount?"** The server re-validates every
request and evaluates the policy itself. The model's claim about what it is
doing is never the thing that is checked.

**"What stops a double charge?"** Two independent idempotency guards — a unique
index in the database that catches a duplicate before any network call, and
Stripe's own idempotency key that catches one that got past it. Plus a
single-use approval token and a status guard on execution.

**"Is this just Stripe?"** Today, yes — one integration working well beat
several working shallowly. The `Adapter` interface is the seam; a second
processor implements `type`, `name`, and `execute`.
