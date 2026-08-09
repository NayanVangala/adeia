# HTTP API

Base URL in development is `http://localhost:3000`.

## Authentication

Every `/v1/*` endpoint takes a bearer token:

```
authorization: Bearer adeia_sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are minted by `npm run seed`, which prints the plaintext exactly once. Only
`sha256(key)` is stored, so a lost key cannot be recovered — re-seed the project.
The stored hash is compared with `timingSafeEqual`, not `===`.

A missing, malformed, or unknown key is `401 {"error":"unauthorized"}`. The key
pins the request to exactly one project; every query downstream is scoped by the
project it resolves to, never by anything in the request body or path.

## Endpoints

| Method | Path | Auth | Status |
|---|---|---|---|
| `GET` | [`/healthz`](#get-healthz) | no | **shipped** |
| `GET` | [`/v1/actions/:id`](#get-v1actionsid) | yes | **shipped** |
| `POST` | [`/v1/actions`](#post-v1actions) | yes | **shipped** |
| `GET` | [`/approvals/:token`](#get-approvalstoken) | token | planned (P5) |
| `POST` | [`/approvals/:token`](#post-approvalstoken) | token | planned (P5) |
| `GET` | [`/v1/actions/:id/audit`](#get-v1actionsidaudit) | yes | planned (P6) |
| `GET` | [`/v1/audit`](#get-v1audit) | yes | planned (P6) |

---

### `GET /healthz`

**shipped.** No auth. Liveness only — it does not check the database.

```bash
curl localhost:3000/healthz
# → 200 {"ok":true}
```

---

### `GET /v1/actions/:id`

**shipped.** Returns one action, scoped to the calling project.

```bash
curl -H "authorization: Bearer $ADEIA_API_KEY" \
  localhost:3000/v1/actions/act_8xk2m4pq7vn3jd6wztc0b
```

| Status | Body | When |
|---|---|---|
| `200` | [action record](json/examples/response-executed.json) | Found, and it belongs to your project |
| `401` | [`unauthorized`](json/examples/error-unauthorized.json) | Missing or bad key |
| `404` | [`not_found`](json/examples/error-not-found.json) | Unknown id **or another project's action** |

An action belonging to another project returns `404`, not `403`. A `403` would
confirm the id exists, which turns the endpoint into a membership oracle over
every action in the system. Both answers mean "you cannot have this"; the API
returns the one that leaks nothing.

#### The action record

| Field | Type | Notes |
|---|---|---|
| `id` | string | `act_` prefixed |
| `projectId` | string | `proj_` prefixed |
| `type` | string | `payment` |
| `params` | object | As submitted, validated — see [payment-params.schema.json](json/payment-params.schema.json) |
| `status` | string | See [status-machine.md](status-machine.md) |
| `decision` | string \| null | `allow` · `require_approval` · `deny` |
| `decisionReason` | string \| null | Human-readable, and always names the number that triggered it |
| `idempotencyKey` | string | Unique per project |
| `result` | object \| null | Adapter output once executed |
| `error` | string \| null | Adapter error code once failed |
| `createdAt` | string | ISO-8601 UTC |
| `decidedAt` | string \| null | When the policy engine ruled |
| `executedAt` | string \| null | When the adapter succeeded |

---

### `POST /v1/actions`

**shipped.** The endpoint an agent calls to request an action.

```bash
curl -X POST localhost:3000/v1/actions \
  -H "authorization: Bearer $ADEIA_API_KEY" -H "content-type: application/json" \
  -d @docs/json/examples/request-under-limit.json
```

An allowed request reaches the [Stripe adapter](payments.md) and produces a real
test-mode PaymentIntent. The server will not start without a `sk_test_` key.

Body: [action-request.schema.json](json/action-request.schema.json). Unknown
fields are rejected rather than silently dropped, so a misspelled key is a `400`
you can see instead of a setting that never took effect.

| Status | Meaning | Example |
|---|---|---|
| `201` | Decided and finished — `executed` or `failed` | [executed](json/examples/response-executed.json) · [failed](json/examples/response-failed.json) |
| `202` | Paused — `pending_approval`, poll for the outcome | [pending](json/examples/response-pending-approval.json) |
| `200` | Refused by policy — `denied` | [denied](json/examples/response-denied.json) |
| `400` | Malformed body | [validation](json/examples/error-validation.json) |
| `401` | Bad key | [unauthorized](json/examples/error-unauthorized.json) |

Three things about these codes are deliberate:

- **A denial is `200`, not `4xx`.** The API call succeeded; it is reporting a
  policy outcome. A client that treats a denial as a transport error will retry
  a refused payment forever.
- **`202` means "not finished — poll this."** It is the only code that tells an
  SDK the action is still in flight.
- **An adapter failure is `201`, not `500`.** A declined card is a recorded
  outcome, not a server error. Returning `500` makes callers retry a payment
  that already reached the processor.

`idempotencyKey` is unique per project. Re-sending an identical request returns
the original record unchanged and does not re-run the action — the lookup happens
before any side effect, including the audit write.

---

### `GET /approvals/:token`

**planned (P5).** Renders the decision page. **Mutates nothing.**

The token is 32 random bytes, base64url encoded, delivered only by email. Only
`sha256(token)` is stored, so a leaked `approvals` table is not a set of live
approve buttons.

---

### `POST /approvals/:token`

**planned (P5).** Body `decision=approve|deny`. This is where the decision is
recorded and the action either executes or is denied.

**Approval is never a GET.** Corporate mail scanners, Slack and iMessage link
unfurlers, and browser prefetch all issue GET requests against links in email. A
mutating GET would auto-approve every payment the moment the mail was delivered,
before a human had read it. The page is a GET; the buttons are POSTs.

A used or expired token returns `410` with an explanatory page. Two independent
guards prevent double execution: the approval row is single-use, and the action
service refuses to execute anything whose status is not exactly `approved`.

---

### `GET /v1/actions/:id/audit`

**planned (P6).** The ordered event list for one action, project-scoped exactly
like `GET /v1/actions/:id` — another project's action is a `404`.

### `GET /v1/audit`

**planned (P6).** Project-wide feed, newest first. Takes `limit` and `cursor`.

---

## Error bodies

| Body | Codes |
|---|---|
| `{"error":"unauthorized"}` | 401 |
| `{"error":"not_found"}` | 404 |
| `{"error":"invalid_request","issues":[…]}` | 400 — `issues` is the zod issue list |
| `{"error":"internal_error"}` | 500 |

Error responses never carry a secret, a key, or a key hash.
