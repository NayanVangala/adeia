# Deploying adeia.xyz

Two paths. The site is static, so it can go up on a CDN tonight with nothing
to maintain. The API needs a server with a real disk, and that is a separate
decision you can make later without redoing any of the first part.

- **[Path A — Cloudflare Pages](#path-a--cloudflare-pages)** is the current
  plan. Static files, free, nothing running. The footer visit counter stays
  hidden, and the approval flow keeps running from a laptop through a tunnel.
- **[Path B — Fly.io](#path-b--flyio)** is for when somebody other than you
  needs to hit the API — an approval email tapped by a person who is not
  sitting at your machine.

Switching from A to B is a DNS change and one deploy. Nothing in the site
itself changes.

---

## What you need either way

Two things I cannot do for you:

1. **DNS control.** adeia.xyz is registered through TLD Registrar Solutions
   and currently sits on Generation XYZ's parking nameservers
   (`PARKING1.GEN.XYZ`, `PARKING2.GEN.XYZ`). Step one of Path A moves that to
   Cloudflare.
2. **An inbox for `hello@adeia.xyz`.** The landing page's *Get in touch*
   link points there. Until it exists, that link opens a mail client
   addressed to nobody. Cloudflare Email Routing does this free once the
   domain is on their nameservers.

---

## Path A — Cloudflare Pages

### 1. Move DNS to Cloudflare

Create an account at <https://dash.cloudflare.com/sign-up>, then *Add a
site* → `adeia.xyz` → **Free** plan. Cloudflare shows two nameservers
assigned to your account, of the form `<name>.ns.cloudflare.com`.

Log in at gen.xyz with the account you bought the domain through, find
adeia.xyz, and replace the parking nameservers with Cloudflare's two.

WHOIS shows `clientTransferProhibited` and `serverTransferProhibited` on the
domain. Those are registrar-transfer locks, not DNS locks, so changing
nameservers is unaffected. If the panel refuses anyway, the fallback is to
add records directly in gen.xyz's own DNS editor — the site still works, but
the email forwarding below has to come from somewhere else.

Cloudflare emails you when the nameservers go active. Usually minutes.

### 2. Deploy the site

```bash
npm run site:build
```

```bash
npx wrangler pages deploy src/frontend --project-name adeia
```

The first run prompts you to log in and creates the project. `src/frontend`
is the whole deployable — the HTML, `styles/`, `fonts/`, `images/`,
`vendor/`, and the four documentation pages. There is no build step to run
first; `site:build` only reassembles `index.html` from `partials/`.

`_headers` and `_redirects` in that directory are read by Pages
automatically. They set cache lifetimes, a few security headers, and send
the legacy `.html` URLs to their canonical extensionless form.

### 3. Attach the domain

In the Pages project → *Custom domains* → *Set up a custom domain* → enter
`adeia.xyz`. Repeat for `www.adeia.xyz`. Because DNS is already on
Cloudflare, the records and the certificate are created for you.

### 4. Email forwarding

Dashboard → adeia.xyz → *Email* → *Email Routing* → enable. Add a custom
address `hello@adeia.xyz` forwarding to your real inbox, and confirm the
verification mail Cloudflare sends to the destination. It adds the MX
records itself.

### 5. Check it

```bash
curl -sI https://adeia.xyz | head -1
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://adeia.xyz/audit
```

Both should be `200`. Then open the page and confirm the hero particle field
animates, the capability bands expand, and the ledger sequence plays.

The footer visit count will not appear. That is correct on this path —
`visits.js` hides the element when it cannot reach an API rather than
showing a number it made up.

### Redeploying

```bash
npm run site:check && npx wrangler pages deploy src/frontend --project-name adeia
```

`site:check` fails if `index.html` is stale against `partials/`. Run
`npm run site:build` and commit if it does.

---

## Path B — Fly.io

Take this path when the API has to be reachable without you starting a
tunnel. One machine serves the site and `/v1` from one origin: no CORS, one
certificate, and the visit counter works.

The database is SQLite on a mounted volume, so this is **one machine**. Do
not scale it past a single instance without moving the database somewhere
built for concurrent writers.

### Deploy

```bash
brew install flyctl && fly auth login
```

```bash
fly launch --no-deploy --copy-config --name adeia --region syd
```

`--copy-config` uses the committed `fly.toml` rather than generating one.
Change `primary_region` if `syd` is not closest; `fly platform regions`
lists them.

```bash
fly volumes create adeia_data --size 1 --region syd
```

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
rainbow table away from an IP address. Generate it, never ship the
development default, and note that changing it later resets deduplication:
today's returning visitors count once more, nothing else moves.

```bash
fly deploy
```

Boot verifies the SMTP credentials before the server listens, so bad
credentials fail the deploy rather than surfacing the first time an
over-limit action tries to email someone.

### Point the domain at it

If you came from Path A, first delete the Pages custom domain for
adeia.xyz — two things cannot answer for the same hostname.

```bash
fly ips allocate-v4 && fly ips allocate-v6 && fly ips list
```

In Cloudflare DNS, using the addresses `fly ips list` printed:

| Type    | Name  | Value          | Proxy |
| ------- | ----- | -------------- | ----- |
| `A`     | `@`   | the IPv4       | off   |
| `AAAA`  | `@`   | the IPv6       | off   |
| `CNAME` | `www` | `adeia.xyz`    | off   |

Turn the orange proxy cloud **off** for these. Fly terminates TLS itself,
and proxying puts two certificate authorities in the same path.

```bash
fly certs add adeia.xyz && fly certs add www.adeia.xyz
```

`fly certs show adeia.xyz` reports progress. If it stalls, check the DNS
record first.

### Check it

```bash
curl -s https://adeia.xyz/healthz
```

```bash
curl -s -X POST https://adeia.xyz/v1/site/visits
```

The second should return `{"total":N,"today":M}`, and the footer counter
will then appear.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://adeia.xyz/v1/actions
```

`401` is correct — the action API is key-authenticated. A `404` would mean
the static file handler is catching routes it should not.

### Redeploying

```bash
npm run site:check && npm test && fly deploy
```

---

## What is not set up

- **No payment processor.** Payments are authorised and recorded; nothing
  settles. The boot banner says so on every start, and so does the footer.
- **One approver.** `APPROVER_EMAIL` is a single address for the whole
  deployment. Per-project approvers are not built.
- **No rate limiting** on the public endpoints. `/v1/site/visits` writes at
  most one row per visitor per day, so the write is bounded, but nothing
  throttles the requests themselves.
- **No backups** on Path B. The volume is a single disk. `fly volumes
  snapshots list adeia_data` shows Fly's automatic daily snapshots;
  restoring one is manual and has never been rehearsed.
- **No Content-Security-Policy.** `audit.html` carries an inline script for
  its tab strip, so a policy worth having needs that moved to a file first.
  `_headers` explains the reasoning where the policy would go.
