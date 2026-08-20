# Deploying adeia.xyz

Two paths. The site is static, so it can go up on a CDN tonight with nothing
to maintain. The app needs somewhere to run and a database that survives between
requests, and that is a separate decision you can make later without redoing
any of the first part.

- **[Path A — Cloudflare Pages](#path-a--cloudflare-pages)** is the current
  plan. Static files, free, nothing running. The footer visit counter stays
  hidden, and the approval flow keeps running from a laptop through a tunnel.
- **[Path B — Vercel and Turso](#path-b--vercel-and-turso)** is for when
  somebody other than you needs to hit the API — an approval email tapped by
  a person who is not sitting at your machine.

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
is the whole deployable — the HTML, `styles/`, `fonts/`, `vendor/`, and the
four documentation pages. There is no build step to run
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

## Path B — Vercel and Turso

Take this path when the API has to be reachable without you starting a
tunnel: an approval email tapped by somebody who is not sitting at your
machine.

The split is deliberate. The nine marketing pages stay on Cloudflare Pages
at `adeia.xyz` — they are static files and a CDN is the right thing to serve
them. The app is a Next.js function on Vercel at `app.adeia.xyz`, and the
database is Turso, which is SQLite reached over HTTPS.

The database has to be remote because a serverless function's filesystem is
discarded when the request ends. Anything written to a local file would be
gone by the time somebody taps the link it just emailed them.

Two free accounts, neither asking for a card: <https://turso.tech> and
<https://vercel.com>.

### 1. The database

```bash
brew install tursodatabase/tap/turso && turso auth login
```

```bash
turso db create adeia
```

```bash
turso db show adeia --url && turso db tokens create adeia
```

The dashboard at <https://turso.tech> does the same thing without installing
anything, which is faster if you only need it once.

Put both values in `.env` at the repo root:

```
TURSO_DATABASE_URL=libsql://adeia-<org>.turso.io
TURSO_AUTH_TOKEN=<token>
```

Then create the tables:

```bash
npm run db:migrate
```

That reads the same environment the server does, so there is no way to
migrate one database while the app talks to another. It applies the four
migrations in `src/backend/drizzle` unchanged — libSQL is a fork of SQLite,
not a different database, which is why nothing about the schema or the
queries had to move.

### 2. A production OAuth app

The existing GitHub OAuth app points at `localhost`. Register a second one
at <https://github.com/settings/developers> rather than editing the first,
so local sign-in keeps working:

| Field                      | Value                                          |
| -------------------------- | ---------------------------------------------- |
| Homepage URL               | `https://adeia.xyz`                            |
| Authorization callback URL | `https://app.adeia.xyz/auth/github/callback`   |

The callback must match exactly, including scheme and no trailing slash.

### 3. Deploy

Import the repository at <https://vercel.com/new>. Leave the root directory
as the repository root — `vercel.json` already names the build:

```json
"buildCommand": "npm run build --workspace @adeia/web",
"outputDirectory": "src/web/.next"
```

Set these in Vercel's environment variables, for Production. Everything not
listed has a working default:

| Variable                | Value                                          |
| ----------------------- | ---------------------------------------------- |
| `TURSO_DATABASE_URL`    | from step 1                                    |
| `TURSO_AUTH_TOKEN`      | from step 1                                    |
| `PUBLIC_BASE_URL`       | `https://app.adeia.xyz`                        |
| `GITHUB_REDIRECT_URI`   | `https://app.adeia.xyz/auth/github/callback`   |
| `GITHUB_CLIENT_ID`      | from step 2                                    |
| `GITHUB_CLIENT_SECRET`  | from step 2                                    |
| `APPROVAL_FROM_EMAIL`   | a sender your mail provider has verified       |
| `APPROVER_EMAIL`        | where approval requests land                   |
| `ADEIA_SITE_ORIGINS`    | `https://adeia.xyz`                            |
| `ADEIA_TRUST_PROXY`     | `true`                                         |
| `ADEIA_VISIT_SALT`      | any long random string                         |
| `ANTHROPIC_API_KEY`     | optional; without it the classifier refuses    |

Then one of:

| Transport | Variables                                     |
| --------- | --------------------------------------------- |
| Resend    | `RESEND_API_KEY`                              |
| SMTP      | `SMTP_USER` and `SMTP_PASSWORD`               |

Resend is the better fit here. SMTP works — the send is awaited inside the
request, so nothing is frozen mid-flight — but every cold start pays for a
TLS handshake and a login, and consumer providers routinely refuse mail from
datacenter addresses, which looks exactly like an approval nobody answered.

`ADEIA_SITE_ORIGINS` matters now in a way it did not before. The visit
counter is on `adeia.xyz` and the endpoint it calls is on `app.adeia.xyz`,
so the request is cross-origin and the server has to name the origin it will
answer. `ADEIA_TRUST_PROXY` is safe here because Vercel overwrites
`x-forwarded-for`; on a directly exposed server it would let one client
inflate the count by changing a header.

### 4. Point the subdomain at it

Vercel gives you a hostname when the first deploy finishes. In Cloudflare
DNS:

| Type    | Name  | Value                   | Proxy |
| ------- | ----- | ----------------------- | ----- |
| `CNAME` | `app` | `cname.vercel-dns.com`  | off   |

Proxy **off**. Vercel terminates TLS itself, and proxying puts two
certificate authorities in the same path.

Add `app.adeia.xyz` as a domain on the Vercel project so it issues the
certificate.

`adeia.xyz` itself does not change. It stays on Pages.

### 5. Turn on the forwards, then check

`src/frontend/_redirects` sends `/dashboard`, `/approvals/*` and `/auth/*`
to `app.adeia.xyz`. Those rules point at a host that does not answer until
step 4 is done, so redeploy Pages last:

```bash
npm run site:build && npx wrangler pages deploy src/frontend --project-name adeia --branch main
```

Then:

```bash
curl -s https://app.adeia.xyz/healthz
```

```bash
curl -s -X POST https://app.adeia.xyz/v1/site/visits
```

The second returns `{"total":N,"today":M}`, and the footer counter on
adeia.xyz appears.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://app.adeia.xyz/v1/actions
```

`401` is correct — the action API is key-authenticated.

Then sign in at <https://adeia.xyz/dashboard>, which should forward to
`app.adeia.xyz` and offer GitHub. That exercises the OAuth callback, the
session cookie and the database in one go.

### Redeploying

```bash
npm run site:check && npm test && git push
```

Vercel builds on push. The static site is separate and only needs a deploy
when something under `src/frontend` changes:

```bash
npx wrangler pages deploy src/frontend --project-name adeia --branch main
```

Migrations are never automatic. Run `npm run db:migrate` yourself, before the
deploy that needs the new column — a function has no filesystem to read the
migration folder from, and every cold start would otherwise race every other
one to alter the same tables.
---

## What is not set up

- **No payment processor.** Payments are authorised and recorded; nothing
  settles. The boot banner says so on every start, and so does the footer.
- **One approver.** `APPROVER_EMAIL` is a single address for the whole
  deployment. Per-project approvers are not built.
- **No rate limiting** on the public endpoints. `/v1/site/visits` writes at
  most one row per visitor per day, so the write is bounded, but nothing
  throttles the requests themselves.
- **No backups** on Path B. Turso keeps point-in-time restore on its own
  schedule; nothing here has ever rehearsed a restore, and no dump is taken
  on any schedule of ours. `turso db shell adeia .dump` is the manual one.
- **No Content-Security-Policy.** `audit.html` carries an inline script for
  its tab strip, so a policy worth having needs that moved to a file first.
  `_headers` explains the reasoning where the policy would go.
