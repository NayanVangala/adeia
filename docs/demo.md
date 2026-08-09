# Demo runbook

Written to be followed literally under time pressure. Do the setup once, well
before you present; the run itself is five commands.

**What the audience sees:** an agent settles a $25 invoice on its own, tries to
settle a $500 one, stops, emails you, waits — you approve on your phone — and it
resumes and reports both outcomes. Then the audit trail.

**No payment processor is attached.** Payments are authorised and recorded;
nothing settles. Say this out loud once, early, in your own words — the audit
trail is on screen at the end and it says `settled: false`. Being the one who
points that out costs nothing. Being asked about it after not mentioning it
costs the room.

What is real: the policy decision, the pause, the email, the token, the human
click, the resume, the trail. What is absent is one adapter behind all of it.

---

## One-time setup

### 1. Accounts

| | Needed for | Watch out for |
|---|---|---|
| Resend account + **verified sender domain** | Approval email | **Verification is not instant. Do this days ahead.** |
| Anthropic API key | The demo agent only | The Adeia server never calls a model |

### 2. `.env` at the repo root

```bash
cp config/.env.example .env
```

Fill in:

```
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

Expect this. If the approval line is missing, stop and fix it — the server
refuses to start rather than run half-configured:

```
[adeia] listening on http://localhost:3000  (db: ./adeia.db)
[adeia] adapters: ledger
[adeia] NO PAYMENT PROCESSOR ATTACHED — payments are authorised and recorded;
[adeia]   no money moves. Register a processor adapter to change that.
[adeia] approvals: you@example.com via https://your-tunnel.ngrok-free.app
```

One caveat the boot check cannot cover: it catches *missing* configuration, not
*placeholder* configuration. A `.env` still holding `re_...` and
`https://your-tunnel.ngrok-free.app` boots perfectly and fails at the first
email. Check the printed approval line names your real address and your real
tunnel.

### 4. Open these before you start talking

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
| 1 | Agent settles $25 | Auto-executes. Agent reports it and moves on. |
| 2 | Agent tries $500 | Prints `⏸ … needs human approval`, then waits. Email arrives within seconds. |
| 3 | **Open the link on your phone** | Page renders with the real amount. In the spare terminal, `curl localhost:3000/v1/actions/<id>` still shows `pending_approval`. **This is the prefetch-safety beat — say out loud that opening the link approved nothing.** |
| 4 | Tap Approve | Success page. Agent resumes and reports both invoices. |
| 5 | Reload the approval page | "Link no longer valid", HTTP 410. The action stays `executed` — it does not run twice. |
| 6 | `npm run audit -- <actionId>` | The full trail: requested → policy.evaluated → pending_approval → approval.sent → approval.granted → executing → executed. |

**Two `executed` actions at the end. Not one, not three.** Confirm it in the
spare terminal:

```bash
sqlite3 adeia.db "SELECT id, status FROM actions;"
```

---

## If something goes wrong

| Symptom | Cause | Do this |
|---|---|---|
| Server won't start, names `PUBLIC_BASE_URL` etc. | Approval flow unconfigured | Fill in the Resend block. It is refusing on purpose. |
| Server starts but the email never sends | `.env` still holds placeholders | The boot check catches missing values, not `re_...`. Check the printed approval line. |
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
limit, could not have reached the outside world while the payment was waiting,
and could not have approved itself — not because it was told not to, but because
there is no code path that does it.

---

## Notes for questions you'll get

**"Does any money actually move?"** No, and the system says so on every boot and
in every audit record — `settled: false`. There is no processor attached. Answer
it flatly; it is a smaller admission than it feels like on stage, and it gets
much larger if the room finds it rather than you.

**"Then what did I just watch?"** Everything except settlement. An agent with no
credentials asked to spend, a policy it cannot edit decided, one request paused,
a human was reached over real email and made a real decision on a real device,
the action resumed, and every step of it is on record. Attaching a processor is
one file and one line in `server.ts`. None of the rest is.

**"Why not just mock the processor so it looks real?"** Because a record that
reads like a settled charge is believed by everything downstream — the trail,
the spend calculation, this screen. `status: "recorded"` and `settled: false`
are what an honest empty seam looks like. See
[payments.md](payments.md#why-there-is-no-mock-processor).

**"What if the model just calls the processor directly?"** It holds no payment
credentials and has no tool that reaches one. Its entire world is one
`pay_vendor` function.

**"What if the model lies about the amount?"** The server re-validates every
request and evaluates the policy itself. The model's claim about what it is
doing is never the thing that is checked.

**"What stops a double charge?"** Today, a unique index on
`(project_id, idempotency_key)` that catches a duplicate before the adapter is
reached, a single-use approval token, and a status guard that refuses anything
not exactly `approved`. A processor's own idempotency key is the fourth guard;
`idempotencyKey` is already carried to the adapter so it plugs straight in.

**"Is it tied to one processor?"** It is tied to none. The `Adapter` interface
is the seam — `type`, `name`, `execute`. That the layer runs correctly with
nothing behind it is the strongest version of that claim, not the weakest.
