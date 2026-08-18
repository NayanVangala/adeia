import { formatMoney, type ActionRecord } from "@adeia/shared";
import { escapeHtml } from "../approvals/page.ts";

/**
 * The dashboard.
 *
 * Server-rendered, no JavaScript, same reasoning as the approval page: it has
 * to work on a phone, on a locked-down network, in whatever browser someone
 * happens to be holding.
 *
 * One rule runs through the whole file. Wherever something was decided, it says
 * *who or what* decided it. A row that ran because a model judged it low risk
 * must never look like a row a person approved.
 */

const STYLE = `
  /* The dashboard wears the same clothes as the rest of Adeia.
     Grounds, marks and inks come from styles/tokens.css, which the server
     already serves from this origin — imported rather than copied so the
     two cannot drift, and so a contrast ratio verified once stays verified. */
  @import url("/styles/tokens.css");

  :root {
    --bg: var(--black);
    --fg: var(--paper);
    --quiet: var(--faint);
    --surface: var(--raised);
    --rule: var(--hair);
    /* Outcomes. Each is a fixed pair, because a pill paints its own
       background and must therefore state its own ink. */
    --ran: #d7e5d9;      --ran-ink: #1f3325;
    --held: #f4e4cd;     --held-ink: #5a3a0d;
    --refused: #f2dcd9;  --refused-ink: #5e1d17;
    --idle: #dcdcdc;     --idle-ink: #333333;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    padding: 2rem 1.25rem 5rem;
    background: var(--bg);
    color: var(--fg);
    font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 1rem;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  main { width: 100%; max-width: 56rem; margin: 0 auto; }
  a { color: inherit; }

  /* ---------- masthead ---------- */
  header.bar {
    display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
    padding-bottom: 1.25rem; margin-bottom: 2.5rem;
    border-bottom: 1px solid var(--rule);
  }
  .wordmark {
    margin: 0; font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.01em;
  }
  .bar-spacer { flex: 1 1 auto; }
  .who { display: flex; align-items: center; gap: 0.625rem; font-size: 0.875rem; color: var(--quiet); }
  .who img { width: 26px; height: 26px; border-radius: 50%; }
  .linkbtn {
    background: none; border: 0; padding: 0; font: inherit; font-size: 0.8125rem;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--quiet);
    cursor: pointer; transition: color 300ms cubic-bezier(0.165, 0.84, 0.44, 1);
  }
  .linkbtn:hover { color: var(--warm); }

  /* ---------- headings ---------- */
  h1 {
    font-size: clamp(1.75rem, 1.2rem + 1.6vw, 2.5rem);
    font-weight: 500; letter-spacing: -0.02em; line-height: 1.1;
    margin: 0 0 0.375rem; color: var(--warm);
  }
  h2 {
    font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase;
    font-weight: 600; color: var(--quiet); margin: 3rem 0 0.875rem;
  }
  .lede { color: var(--quiet); margin: 0 0 2.5rem; max-width: 34rem; }
  .eyebrow {
    font-size: 0.6875rem; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--quiet); margin: 0 0 0.625rem;
  }

  /* ---------- surfaces ---------- */
  .card {
    background: var(--surface); border: 1px solid var(--rule);
    border-radius: 4px; padding: 1.5rem 1.75rem; margin: 0 0 1rem;
  }

  /* ---------- the three figures ---------- */
  .stats { display: flex; gap: 3rem; flex-wrap: wrap; margin: 0 0 2.5rem; }
  .stat-n {
    font-family: "Geist Mono", ui-monospace, Menlo, monospace;
    font-size: 2.25rem; font-weight: 400; line-height: 1; letter-spacing: -0.03em;
  }
  .stat-l {
    font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--quiet); margin-top: 0.5rem;
  }

  /* ---------- the ledger ---------- */
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th {
    text-align: left; font-size: 0.6875rem; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--quiet); font-weight: 500;
    padding: 0 1rem 0.75rem 0; border-bottom: 1px solid var(--rule);
  }
  td {
    padding: 1rem 1rem 1rem 0; border-bottom: 1px solid var(--rule);
    vertical-align: top;
  }
  tr:last-child td { border-bottom: 0; }
  .what { font-weight: 500; font-size: 0.9375rem; }
  .mono {
    font-family: "Geist Mono", ui-monospace, Menlo, monospace;
    font-variant-ligatures: none; letter-spacing: -0.01em;
  }
  .sub { color: var(--quiet); font-size: 0.8125rem; margin-top: 0.25rem; word-break: break-word; }
  .when { color: var(--quiet); white-space: nowrap; font-size: 0.8125rem; }

  /* ---------- outcomes ---------- */
  .pill {
    display: inline-block; padding: 0.25rem 0.625rem; border-radius: 999px;
    font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; white-space: nowrap;
  }
  .pill-exec { background: var(--ran); color: var(--ran-ink); }
  .pill-held { background: var(--held); color: var(--held-ink); }
  .pill-deny { background: var(--refused); color: var(--refused-ink); }
  .pill-fail { background: var(--idle); color: var(--idle-ink); }

  /* The classifier's mark, in the colour tokens.css reserved for it.
     Cooler than everything else on purpose: it marks the one place a model
     decided rather than a rule, and that should register before the words
     are read. --slate on --ink clears AA. */
  .by-model {
    display: block; margin-top: 0.5rem; padding-left: 0.75rem;
    border-left: 2px solid var(--cold); color: var(--cold);
    font-size: 0.8125rem; line-height: 1.45;
  }

  .empty { color: var(--quiet); padding: 2.5rem 0; text-align: center; font-size: 0.875rem; }

  /* ---------- decide ---------- */
  .decide { display: flex; gap: 0.5rem; }
  .decide form { margin: 0; }
  .decide button {
    padding: 0.4375rem 0.9375rem; font-family: inherit; font-size: 0.75rem;
    font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
    border-radius: 3px; border: 1px solid transparent; cursor: pointer;
    white-space: nowrap; transition: all 300ms cubic-bezier(0.165, 0.84, 0.44, 1);
  }
  .decide .yes { background: var(--warm); color: var(--black); }
  .decide .yes:hover { background: var(--hot); }
  .decide .no { background: transparent; color: var(--quiet); border-color: var(--rule); }
  .decide .no:hover { color: var(--refused); border-color: var(--refused); }

  /* ---------- credential ---------- */
  .key {
    font-family: "Geist Mono", ui-monospace, Menlo, monospace;
    font-size: 0.8125rem; background: var(--black); border: 1px solid var(--rule);
    border-radius: 3px; padding: 0.875rem; word-break: break-all;
    margin: 1rem 0; color: var(--warm);
  }

  /* Fixed background, so it states a fixed ink rather than inheriting one
     that is near-white on this ground. */
  .warn {
    background: var(--held); color: var(--held-ink);
    border-left: 3px solid var(--held-ink);
    padding: 0.875rem 1rem; border-radius: 0 3px 3px 0;
    font-size: 0.8125rem; margin: 1rem 0 0;
  }

  .btn {
    display: inline-block; background: var(--warm); color: var(--black);
    text-decoration: none; padding: 0.75rem 1.5rem; border-radius: 3px;
    font-weight: 600; font-size: 0.8125rem; letter-spacing: 0.06em;
    text-transform: uppercase; border: 0; font-family: inherit; cursor: pointer;
    transition: background 300ms cubic-bezier(0.165, 0.84, 0.44, 1);
  }
  .btn:hover { background: var(--hot); }

  .flash {
    border: 1px solid var(--rule); border-left: 3px solid var(--warm);
    background: var(--surface); border-radius: 0 3px 3px 0;
    padding: 0.875rem 1.125rem; margin: 0 0 1.5rem; font-size: 0.875rem;
  }
  .flash-deny { border-left-color: var(--refused); }

  /* ---------- the host allowlist ---------- */
  .hosts { list-style: none; margin: 0 0 1rem; padding: 0; }
  .hosts li {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.625rem 0; border-bottom: 1px solid var(--rule); font-size: 0.875rem;
  }
  .hosts li:last-child { border-bottom: 0; }
  .hosts form { margin: 0 0 0 auto; }
  .addhost { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0; }
  .addhost input[type="text"] {
    flex: 1 1 16rem; padding: 0.625rem 0.75rem; border-radius: 3px;
    border: 1px solid var(--rule); background: var(--black); color: var(--fg);
    font-family: "Geist Mono", ui-monospace, Menlo, monospace; font-size: 0.8125rem;
  }
  .addhost input[type="text"]:focus-visible {
    outline: 2px solid var(--warm); outline-offset: 1px;
  }

  code {
    font-family: "Geist Mono", ui-monospace, Menlo, monospace;
    font-size: 0.8125rem; color: var(--warm);
  }
  .steps { padding-left: 1.25rem; line-height: 1.8; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/** `2026-08-17T05:25:24.123Z` -> `17 Aug, 05:25` */
function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toISOString().slice(11, 16);
  return `${day}, ${time}`;
}

const STATUS_PILL: Record<string, { cls: string; label: string }> = {
  executed: { cls: "pill-exec", label: "ran" },
  executing: { cls: "pill-fail", label: "running" },
  pending_approval: { cls: "pill-held", label: "waiting on you" },
  approved: { cls: "pill-held", label: "approved" },
  denied: { cls: "pill-deny", label: "refused" },
  failed: { cls: "pill-fail", label: "failed" },
  expired: { cls: "pill-fail", label: "expired" },
  pending_policy: { cls: "pill-fail", label: "checking" },
};

function pill(status: string): string {
  const p = STATUS_PILL[status] ?? { cls: "pill-fail", label: status };
  return `<span class="pill ${p.cls}">${escapeHtml(p.label)}</span>`;
}

/** One line naming the action, in the terms of whichever type it is. */
function describe(action: ActionRecord): { headline: string; detail: string; mono: boolean } {
  if (action.type === "http") {
    const method = String(action.params["method"] ?? "");
    const url = String(action.params["url"] ?? "");
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      // Leave the raw string; escaped at render either way.
    }
    return { headline: `${method} ${host}`, detail: url, mono: true };
  }

  const amountCents = Number(action.params["amountCents"] ?? 0);
  const currency = String(action.params["currency"] ?? "usd");
  const recipient = String(action.params["recipient"] ?? "");
  return { headline: formatMoney(amountCents, currency), detail: `to ${recipient}`, mono: false };
}

export interface DashboardAction {
  action: ActionRecord;
  /** The classifier's own words, when a model was what decided this. */
  classifier: { verdict: string; reason: string; model: string } | null;
}

export interface DashboardView {
  user: { login: string; avatarUrl: string | null };
  projectName: string;
  actions: DashboardAction[];
  counts: { waiting: number; ranToday: number; refusedToday: number };
  /** Shown exactly once, immediately after a project is created. */
  freshApiKey?: string;
  /** Hidden field on every form that changes something. */
  csrf: string;
  /** Set after a decision, so the page says what just happened. */
  flash?: { text: string; kind: "approved" | "denied" };
  /** Hosts this project's agents may call. Empty means none, which denies all. */
  allowedHosts: string[];
}

/**
 * The host allowlist, editable.
 *
 * A new project starts empty, which denies every outbound call. That is the
 * right default — guessing which hosts a stranger trusts is not something to
 * do for them — but it is only defensible if changing it takes one field. An
 * empty list with no way to edit it is not a safe default, it is a dead end.
 */
function hostsCard(hosts: string[], csrf: string): string {
  const field = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;

  const rows = hosts
    .map(
      (host) => `<li>
        <span class="mono">${escapeHtml(host)}</span>
        <form method="POST" action="/dashboard/policy/hosts">
          ${field}<input type="hidden" name="remove" value="${escapeHtml(host)}">
          <button class="linkbtn" type="submit">Remove</button>
        </form>
      </li>`,
    )
    .join("");

  const empty = `<p class="warn">No hosts allowed yet, so every outbound call is refused.
    Add the API your agent needs to reach.</p>`;

  return `<div class="card">
    <p class="eyebrow">Hosts your agents may call</p>
    <p style="margin:0;color:var(--faint);font-size:.875rem">
      Exact hostnames only, no paths and no wildcards. Anything not on this list is denied
      before a request is made.
    </p>
    ${hosts.length === 0 ? empty : `<ul class="hosts">${rows}</ul>`}
    <form class="addhost" method="POST" action="/dashboard/policy/hosts">
      ${field}
      <input type="text" name="add" placeholder="api.github.com" aria-label="Hostname to allow" required>
      <button type="submit">Allow</button>
    </form>
  </div>`;
}

/**
 * Approve and deny, in place.
 *
 * POST, with the action id in the path and a CSRF token in the body. Deciding
 * on GET would mean a link preview or a prefetcher could release an action,
 * which is the same reason the emailed approval link only ever renders a page.
 */
function decideButtons(actionId: string, csrf: string): string {
  const field = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  const target = `/dashboard/actions/${encodeURIComponent(actionId)}/decision`;

  return `<div class="decide">
    <form method="POST" action="${target}">
      ${field}<input type="hidden" name="decision" value="approve">
      <button class="yes" type="submit">Approve</button>
    </form>
    <form method="POST" action="${target}">
      ${field}<input type="hidden" name="decision" value="deny">
      <button class="no" type="submit">Deny</button>
    </form>
  </div>`;
}

function actionRow(entry: DashboardAction, csrf: string): string {
  const { action } = entry;
  const { headline, detail, mono } = describe(action);

  // Only rendered when a model is what let this through or held it. Worded so
  // it cannot read as a human decision.
  const byModel =
    entry.classifier === null
      ? ""
      : `<div class="by-model">${
          entry.classifier.verdict === "low"
            ? "A model judged this low risk and let it run"
            : "A model flagged this for you"
        } — ${escapeHtml(entry.classifier.reason)}</div>`;

  const state =
    action.status === "pending_approval"
      ? decideButtons(action.id, csrf)
      : pill(action.status);

  return `<tr>
    <td>
      <div class="what${mono ? " mono" : ""}">${escapeHtml(headline)}</div>
      <div class="sub">${escapeHtml(detail)}</div>
      ${byModel}
    </td>
    <td>${state}</td>
    <td class="when">${escapeHtml(when(action.createdAt))}</td>
  </tr>`;
}

export function renderDashboard(view: DashboardView): string {
  const waiting = view.actions.filter((a) => a.action.status === "pending_approval");
  const rest = view.actions.filter((a) => a.action.status !== "pending_approval");

  /**
   * The key card, in one of two states.
   *
   * With a key: shown once, never again, because only the hash is stored.
   * Without: a button to mint a new one. That button is the reason "shown
   * once" is a reasonable thing to do to somebody — a secret you cannot see
   * again and cannot replace is a locked door with the key inside.
   *
   * Rotating is destructive, so the button says what it breaks before it is
   * pressed rather than after.
   */
  const keyBlock = view.freshApiKey
    ? `<div class="card">
      <p class="eyebrow">Your API key</p>
      <p style="margin:0">This is the only time it is shown. Adeia stores a hash, not the key,
      so it cannot be shown again — but you can generate a new one whenever you want.</p>
      <div class="key">${escapeHtml(view.freshApiKey)}</div>
      <p class="warn">Anyone holding this key can ask Adeia to act inside your policy.
      Keep it out of screenshots and out of git.</p>
    </div>`
    : `<div class="card">
      <p class="eyebrow">API key</p>
      <p style="margin:0 0 .75rem">Your agents authenticate with a key. Adeia only stores a
      hash of it, so an existing key can never be shown again — generating a new one is the
      way to get a key you can read.</p>
      <form method="POST" action="/dashboard/key" style="margin:0">
        <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
        <button class="btn" type="submit">Generate a new key</button>
      </form>
      <p class="warn">This replaces the current key immediately. Anything already using
      the old one stops working until you paste in the new one.</p>
    </div>`;

  const table = (rows: DashboardAction[], emptyText: string): string =>
    rows.length === 0
      ? `<div class="card"><p class="empty">${escapeHtml(emptyText)}</p></div>`
      : `<div class="card"><table>
          <thead><tr><th>What</th><th>State</th><th>When</th></tr></thead>
          <tbody>${rows.map((r) => actionRow(r, view.csrf)).join("")}</tbody>
        </table></div>`;

  const flash = view.flash
    ? `<p class="flash${view.flash.kind === "denied" ? " flash-deny" : ""}">${escapeHtml(
        view.flash.text,
      )}</p>`
    : "";

  const body = `
  <header class="bar">
    <p class="wordmark">Adeia</p>
    <div class="bar-spacer"></div>
    <div class="who">
      ${view.user.avatarUrl ? `<img src="${escapeHtml(view.user.avatarUrl)}" alt="">` : ""}
      <span>${escapeHtml(view.user.login)}</span>
      <form method="POST" action="/auth/logout" style="margin:0">
        <button class="linkbtn" type="submit">Sign out</button>
      </form>
    </div>
  </header>

  <h1>${escapeHtml(view.projectName)}</h1>
  <p class="lede">Everything your agents asked to do, and what Adeia did about it.</p>

  ${flash}
  ${keyBlock}

  <div class="stats">
    <div><div class="stat-n">${view.counts.waiting}</div><div class="stat-l">waiting on you</div></div>
    <div><div class="stat-n">${view.counts.ranToday}</div><div class="stat-l">ran today</div></div>
    <div><div class="stat-n">${view.counts.refusedToday}</div><div class="stat-l">refused today</div></div>
  </div>

  <h2>Waiting on you</h2>
  ${table(waiting, "Nothing is waiting. Adeia will email you when something needs a decision.")}

  <h2>Recent activity</h2>
  ${table(rest, "No actions yet. Point an agent at Adeia with your API key and they will show up here.")}

  <h2>Policy</h2>
  ${hostsCard(view.allowedHosts, view.csrf)}
  `;

  return shell(`${view.projectName} — Adeia`, body);
}

/** Shown to a signed-out visitor. */
export function renderSignIn(configured: boolean): string {
  const body = `
  <header class="bar"><p class="wordmark">Adeia</p></header>
  <h1>Sign in</h1>
  <p class="lede">See what your agents asked to do, what ran, and what is waiting on you.</p>
  <div class="card">
    ${
      configured
        ? `<p style="margin:0 0 1.25rem">Adeia uses your GitHub account to sign you in. It asks for
           <code>read:user</code> and nothing else — it never requests access to your repositories.</p>
           <p style="margin:0"><a class="btn" href="/auth/github">Continue with GitHub</a></p>`
        : `<p style="margin:0">Sign-in is not configured on this deployment.</p>`
    }
  </div>`;
  return shell("Sign in — Adeia", body);
}

/**
 * What a deployment without an OAuth app serves.
 *
 * Written as instructions rather than an error, because the person seeing it
 * is almost always the person who can fix it, and the fix is four lines.
 */
export function renderSignInUnavailable(): string {
  const body = `
  <header class="bar"><p class="wordmark">Adeia</p></header>
  <h1>Sign-in is not set up yet</h1>
  <p class="lede">The dashboard needs a GitHub OAuth app before anyone can log in.</p>
  <div class="card">
    <ol class="steps">
      <li>Go to <code>github.com/settings/developers</code> and create a new OAuth App.</li>
      <li>Set the callback URL to exactly <code>http://localhost:3000/auth/github/callback</code>
          for local use, or your real domain plus <code>/auth/github/callback</code>.</li>
      <li>Copy the client ID, then generate a client secret.</li>
      <li>Put all three in <code>.env</code>:
        <div class="key">GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
GITHUB_REDIRECT_URI=http://localhost:3000/auth/github/callback</div>
      </li>
      <li>Restart the server.</li>
    </ol>
    <p class="warn">The callback URL has to match character for character, port included.
    GitHub refuses the sign-in if it differs at all.</p>
  </div>`;
  return shell("Sign-in not configured — Adeia", body);
}
