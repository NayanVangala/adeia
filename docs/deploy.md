# Deploying adeia.xyz

One app serves the landing page, the documentation pages and the API from a
single origin. No CORS, one certificate, one deploy, and the visit counter
calls a relative path.

The database is SQLite on a mounted volume. That means **one machine** — do
not scale past a single instance without moving the database somewhere built
for concurrent writers.

---

## What you need before anything runs

Three things I cannot do for you:

1. **A Fly.io account** — <https://fly.io/app/sign-up>. Account creation and
   payment details are yours to enter; the free allowance covers one small
   machine and a 1 GB volume.
2. **DNS access** for `adeia.xyz`, wherever Generation XYZ issued it. You
   need to be able to add `A`, `AAAA` and `CNAME` records.
3. **An inbox for `hello@adeia.xyz`.** The landing page's *Get in touch*
   link points there. Forwarding to your real address is enough — most
   registrars offer free email forwarding. Until it exists, that link opens
   a mail client addressed to nobody.

---

## First deploy

```bash
brew install flyctl && fly auth login
```

```bash
fly launch --no-deploy --copy-config --name adeia --region syd
```

`--copy-config` uses the committed `fly.toml` rather than generating a new
one. Change `primary_region` if `syd` is not your closest — `fly platform
regions` lists them.

Create the volume the database lives on:

```bash
fly volumes create adeia_data --size 1 --region syd
```

Set the secrets. These are **not** in `fly.toml`, because that file is
committed:

```bash
fly secrets set \
  SMTP_USER="your-gmail-address" \
  SMTP_PASSWORD="your-16-char-app-password" \
  APPROVAL_FROM_EMAIL="hello@adeia.xyz" \
  APPROVER_EMAIL="the-address-that-approves@example.com" \
  ADEIA_VISIT_SALT="$(openssl rand -hex 32)"
```

`SMTP_PASSWORD` is a Google **app password**, not your account password —
Gmail rejects the account password over SMTP. Generate a fresh one for this
deployment rather than reusing the one in your local `.env`.

`ADEIA_VISIT_SALT` is what stops the stored visitor hash from being a
rainbow table away from an IP address. Generate it, never reuse the
development default, and note that changing it later resets deduplication:
today's returning visitors count once more, and nothing else moves.

Then:

```bash
fly deploy
```

The boot sequence verifies the SMTP credentials before it listens, so a bad
password fails the deploy instead of surfacing the first time an over-limit
action tries to email someone.

---

## Pointing the domain at it

Allocate addresses:

```bash
fly ips allocate-v4 && fly ips allocate-v6 && fly ips list
```

Add these at your DNS provider, using the addresses `fly ips list` printed:

| Type    | Name  | Value                        |
| ------- | ----- | ---------------------------- |
| `A`     | `@`   | the IPv4 from `fly ips list` |
| `AAAA`  | `@`   | the IPv6 from `fly ips list` |
| `CNAME` | `www` | `adeia.xyz`                  |

Then request certificates — one per hostname:

```bash
fly certs add adeia.xyz && fly certs add www.adeia.xyz
```

`fly certs show adeia.xyz` reports progress. Issuance normally takes a few
minutes once DNS has propagated; if it stalls, the DNS record is the thing
to check first.

---

## Verifying it worked

```bash
curl -sI https://adeia.xyz | head -1
```

```bash
curl -s https://adeia.xyz/healthz
```

```bash
curl -s -X POST https://adeia.xyz/v1/site/visits
```

The last one should return `{"total":N,"today":M}`. If it does, the counter
in the footer will show; if the API is unreachable the element stays hidden
rather than inventing a number.

Check that the API did not get shadowed by the static handler:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://adeia.xyz/v1/actions
```

`401` is correct — the action API is key-authenticated. `404` would mean the
static file handler is catching routes it should not.

---

## Deploying again

```bash
npm run site:check && npm test && fly deploy
```

`site:check` fails if `index.html` is stale against `partials/`. If it does,
run `npm run site:build` and commit the result.

---

## What is not set up

- **No payment processor.** Payments are authorised and recorded; nothing
  settles. The boot banner says so on every start, and so does the footer.
- **One approver.** `APPROVER_EMAIL` is a single address for the whole
  deployment. Per-project approvers are not built.
- **No rate limiting** on the public endpoints. `/v1/site/visits` writes one
  row per visitor per day, so the write is bounded, but nothing throttles
  the requests themselves.
- **No backups.** The volume is a single disk. `fly volumes snapshots list
  adeia_data` shows Fly's automatic daily snapshots; restoring one is a
  manual operation and has never been rehearsed.
