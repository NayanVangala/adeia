---
name: response-summary
description: Append a plain-language bold summary to the end of every response - what the user needs to do next, what was built in fifth-grade language, and what it does. Use when responding to any prompt in this project.
---

# Response summary

End **every** response with a bold summary block. It comes after the normal
answer, never instead of it. The answer above it stays as technical as the
work requires; this block is the part someone can read without knowing the
codebase.

## Format

Three labelled lines, each bold, in this order:

```
**What you need to do next:** <one action, or "Nothing — this one's on me.">

**What I did:** <plain language, fifth-grade reading level>

**What it does:** <why it matters, one sentence>
```

## Rules

**Write "What I did" for a smart eleven-year-old.** No jargon. If a technical
term is unavoidable, say what it means in the same breath.

- Not: "Refactored the policy evaluator into a pure function with no I/O."
- Yes: "Split the part that decides yes-or-no away from the part that talks
  to the database, so it can be tested on its own."

**"What you need to do next" is one concrete action**, not a list. If several
things are waiting, name the one that unblocks the most and say how many
others are queued behind it. If nothing is needed from the user, say so
plainly — "Nothing — this one's on me" — rather than inventing a task.

**"What it does" answers "so what".** Skip it only if the response did not
build or change anything.

**Never soften a failure here.** If something broke, is unverified, or was
skipped, this block says so in the same plain language. A summary that reads
cleaner than the truth above it is worse than no summary.

**Keep it short.** Three lines, one sentence each. It is a summary, not a
second copy of the response.

## When the response built nothing

Answering a question, explaining a trade-off, or reading code still gets a
block — just an honest one:

```
**What you need to do next:** Decide whether to keep the API self-hosted.

**What I did:** Read the code and wrote down what actually exists today.

**What it does:** Tells you what's real before you plan around it.
```
