# Risk classifier — design

**Date:** 2026-08-16
**Status:** approved, not implemented
**Scope:** `http` actions only

## The problem

Every write stops for a human. `POST`, `PUT`, `PATCH` and `DELETE` all land in
`approvalMethods`, so an agent doing ordinary work — filing an issue, adding a
DNS record it just created — waits on an email for each one. The approval that
matters gets lost among the ones that do not.

The fix is not to ask less. It is to ask about the right things.

## What this is not

A model deciding whether to consult a human is a guard whose input is written
by the party it guards. An agent that has been prompt-injected controls the
request, and if the request can argue, it will argue its way past the fence.

So the classifier gets no authority it was not explicitly handed. It runs
inside a band the operator opened, it never sees a decision that was already
going to be refused, and it cannot reverse anything the deterministic rules
settled.

## Design

### 1. `evaluate()` stays pure

`src/backend/src/policy/evaluate.ts` performs no I/O, reads no clock and uses
no randomness. Tests depend on that. A classifier is a network call, so it does
not go in this file.

`evaluate()` gains a fourth `Decision`:

| Decision | Meaning |
| --- | --- |
| `deny` | Refused. The classifier never runs. |
| `require_approval` | A human decides. Always. The classifier never runs. |
| `classify` | Deterministic rules found nothing disqualifying, and the operator authorised a model to decide here. |
| `allow` | Runs. |

`classify` is returned, never acted on, by this module. The action service
interprets it.

**`classify` is never persisted.** `actions.decision` continues to hold only
`allow`, `require_approval` or `deny`. `classify` is an instruction to the
service, and by the time a row is written the classifier has resolved it into
one of the three durable values. A `classify` reaching the database would mean
an action was recorded in a state nothing knows how to resume.

### 2. Ordering is the security property

The existing structure — every deny rule before any approval rule — is what
makes this safe, and it does not change. By the time `classify` can be
returned, these have already resolved:

- URL parsed
- private, loopback and link-local hosts rejected
- host allowlist checked
- `deniedMethods` checked
- `maxCallsPerDay` checked

The classifier is therefore never asked about a call that was going to be
denied. Injected text can win inside an opened band. It cannot open one.

### 3. Policy configuration

One new field on `HttpPolicy`:

```ts
/** Methods where a model decides. Never overrides deniedMethods or approvalMethods. */
classifyMethods: string[];
```

Precedence, hardest first:

1. `deniedMethods` — refused outright
2. `approvalMethods` — a human, always
3. `classifyMethods` — the model decides
4. unclassified non-read method — a human (existing default)
5. read method — allowed

A method appearing in more than one list is resolved by this order, so a
misconfiguration is safe rather than ambiguous. `classifyMethods` defaults to
`[]`, meaning existing policies behave exactly as they do now.

Stored in the existing `policies.config` JSON column. No migration.

The seeded demo policy becomes:

```ts
approvalMethods: ["DELETE"],
classifyMethods: ["POST", "PUT", "PATCH"],
```

`DELETE` stops for a person whatever any model concludes.

### 4. The classifier module

New file, `src/backend/src/policy/classify.ts`. Injected into the action
service the way adapters are, so tests need no network and no API key.

```ts
export interface ClassifierInput {
  method: string;
  url: string;
  body: unknown;
}

export interface Verdict {
  risk: "low" | "high";
  /** Shown to a human. Never fed back into any decision. */
  reason: string;
}

export type Classifier = (input: ClassifierInput) => Promise<Verdict>;
```

**Input excludes `description`.** The description is written by the agent under
evaluation and exists to persuade a reader. A URL path carries the signal
without it: `POST /repos/x/y/issues` and `POST /repos/x/y/git/refs` are
distinguishable on the endpoint alone.

**The verdict is binary.** A numeric score becomes a threshold somebody guesses.
`low` maps to `allow`; everything else maps to `require_approval`.

**Model:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`). The judgement is
narrow and the latency sits in the request path.

**Structured output.** The model is required to return the verdict through a
tool schema, so a prose answer is a parse failure rather than something to
interpret.

### 5. Failure is closed

Every one of these produces `require_approval`:

- request timeout (5s)
- API error or network failure
- malformed or schema-invalid response
- model refusal
- any thrown exception

A classifier that cannot answer must never mean yes. The reason recorded says
the classifier failed, so a broken API key shows up as a flood of approval
emails rather than silence.

No caching. Idempotency keys already collapse retries, and a cache keyed on
request shape would let one benign classification be replayed by a later
request that merely looked similar.

### 6. Audit

New event `action.classified`, written before the action proceeds:

```jsonc
{
  "verdict": "low",
  "reason": "Creates an issue on an existing repository.",
  "model": "claude-haiku-4-5-20251001",
  "durationMs": 412,
  "failed": false
}
```

The trail must state that a **model** allowed this, and must never render in a
way that reads as though a person did. The same distinction carries into the
dashboard when it is built.

`reason` is model-generated text on its way to a browser. It passes through the
existing `escapeHtml` in `src/backend/src/approvals/page.ts`, exactly as the
agent's description does.

### 7. Cost

Bounded by `maxCallsPerDay`, which already exists — no action, no
classification. No separate budget is introduced.

## Out of scope

**Payments.** Deterministic amount limits stay. An amount is already a good
proxy for risk and a model adds nothing over a `$50` ceiling.

**Learning from past decisions.** The classifier is stateless. Feeding it
earlier approvals would let an agent that got one thing approved widen its own
band later.

**Operator-editable classifier prompts.** The prompt ships with the code. A
user-editable prompt is a user-editable fence.

## Testing

Unit, `evaluate()`:

- `classifyMethods` returns `classify`
- `deniedMethods` beats `classifyMethods`
- `approvalMethods` beats `classifyMethods`
- a blocked host returns `deny` even when the method is in `classifyMethods`
- an exceeded daily cap returns `deny` before `classify`
- absent or empty `classifyMethods` reproduces today's behaviour exactly

Unit, classifier module, with a stub transport:

- `low` produces `allow`
- `high` produces `require_approval`
- timeout produces `require_approval`
- malformed response produces `require_approval`
- thrown error produces `require_approval`
- `description` is absent from the payload sent to the model

Integration, action service with a stub classifier:

- a classified allow executes and writes `action.classified` then `action.executed`
- a classified high risk writes `action.classified` then `action.pending_approval`
- a failing classifier pauses for approval and records the failure

## Open questions

None.
