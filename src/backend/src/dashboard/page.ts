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
  :root {
    --paper: #E9EBEE; --ink: #0B0E14; --ink-soft: #48505E;
    --rule: #C6CBD2; --surface: #FFFFFF;
    --held: #B3701C; --exec: #3F6A4C; --deny: #97362D; --model: #4A5578;
    --bg: var(--paper); --fg: var(--ink);
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0B0E14; --fg: #E9EBEE; --ink-soft: #98A0AE;
            --rule: #2A303B; --surface: #141922; --model: #8B96BC; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main { width: 100%; max-width: 54rem; margin: 0 auto; }
  a { color: inherit; }
  header.bar {
    display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
    padding-bottom: 1.25rem; margin-bottom: 2rem; border-bottom: 1px solid var(--rule);
  }
  .wordmark { font-weight: 600; letter-spacing: -.01em; font-size: 1.125rem; margin: 0; }
  .bar-spacer { flex: 1 1 auto; }
  .who { display: flex; align-items: center; gap: .5rem; font-size: .875rem; color: var(--ink-soft); }
  .who img { width: 24px; height: 24px; border-radius: 50%; }
  .linkbtn {
    background: none; border: 0; padding: 0; font: inherit; font-size: .875rem;
    color: var(--ink-soft); text-decoration: underline; cursor: pointer;
  }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; line-height: 1.2; }
  h2 { font-size: 1rem; margin: 2.5rem 0 .75rem; }
  .lede { color: var(--ink-soft); margin: 0 0 2rem; }
  .eyebrow {
    font-size: .75rem; letter-spacing: .08em; text-transform: uppercase;
    color: var(--ink-soft); margin: 0 0 .5rem;
  }
  .card {
    background: var(--surface); border: 1px solid var(--rule);
    border-radius: 12px; padding: 1.25rem 1.5rem; margin: 0 0 1rem;
  }
  .stats { display: flex; gap: 2.5rem; flex-wrap: wrap; margin: 0 0 2rem; }
  .stat-n { font-size: 1.75rem; font-weight: 600; line-height: 1; }
  .stat-l { font-size: .8125rem; color: var(--ink-soft); margin-top: .25rem; }
  table { width: 100%; border-collapse: collapse; font-size: .875rem; }
  th {
    text-align: left; font-size: .75rem; letter-spacing: .06em; text-transform: uppercase;
    color: var(--ink-soft); font-weight: 500; padding: 0 .75rem .5rem 0;
    border-bottom: 1px solid var(--rule);
  }
  td { padding: .75rem .75rem .75rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .what { font-weight: 500; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-ligatures: none; }
  .sub { color: var(--ink-soft); font-size: .8125rem; margin-top: .125rem; word-break: break-word; }
  .when { color: var(--ink-soft); white-space: nowrap; }
  .pill {
    display: inline-block; padding: .1875rem .5rem; border-radius: 999px;
    font-size: .75rem; font-weight: 500; white-space: nowrap;
  }
  /* Fixed backgrounds, so each states its own ink rather than inheriting a
     --fg that flips to near-white in dark mode. */
  .pill-exec { background: #E4EDE7; color: #26452F; }
  .pill-held { background: #FBF3E7; color: #6B4310; }
  .pill-deny { background: #F6E4E2; color: #6B211A; }
  .pill-fail { background: #EDEEF0; color: #3A414D; }
  /* The classifier's mark. Deliberately distinct from every human state: a
     reader must never mistake a model's verdict for someone's decision. */
  .by-model {
    display: inline-block; margin-top: .25rem; font-size: .75rem;
    color: var(--model); border-left: 2px solid var(--model); padding-left: .5rem;
  }
  .empty { color: var(--ink-soft); padding: 2rem 0; text-align: center; }
  .decide { display: flex; gap: .5rem; }
  .decide form { margin: 0; }
  .decide button {
    padding: .4rem .875rem; font-size: .8125rem; font-weight: 600; font-family: inherit;
    border-radius: 6px; cursor: pointer; border: 1px solid transparent; white-space: nowrap;
  }
  .decide .yes { background: var(--exec); color: #fff; }
  .decide .no { background: transparent; color: var(--deny); border-color: var(--deny); }
  .flash {
    border: 1px solid var(--rule); border-left: 3px solid var(--exec);
    background: var(--surface); border-radius: 0 8px 8px 0;
    padding: .875rem 1rem; margin: 0 0 1.5rem; font-size: .875rem;
  }
  .flash-deny { border-left-color: var(--deny); }
  .hosts { list-style: none; margin: .75rem 0 0; padding: 0; }
  .hosts li {
    display: flex; align-items: center; gap: .75rem;
    padding: .5rem 0; border-bottom: 1px solid var(--rule); font-size: .875rem;
  }
  .hosts li:last-child { border-bottom: 0; }
  .hosts form { margin: 0 0 0 auto; }
  .addhost { display: flex; gap: .5rem; margin-top: 1rem; flex-wrap: wrap; }
  .addhost input {
    flex: 1 1 16rem; min-width: 0; padding: .55rem .75rem; font: inherit; font-size: .875rem;
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--rule); border-radius: 6px;
  }
  .addhost button {
    padding: .55rem 1rem; font: inherit; font-size: .875rem; font-weight: 600;
    background: var(--exec); color: #fff; border: 0; border-radius: 6px; cursor: pointer;
  }
  .key {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem;
    background: var(--bg); border: 1px solid var(--rule); border-radius: 6px;
    padding: .75rem; word-break: break-all; margin: .75rem 0;
  }
  .warn {
    background: #FBF3E7; border-left: 3px solid #B3701C; color: #0B0E14;
    padding: .75rem 1rem; border-radius: 0 6px 6px 0; font-size: .875rem; margin: .75rem 0 0;
  }
  .btn {
    display: inline-block; background: var(--exec); color: #fff; text-decoration: none;
    padding: .8rem 1.5rem; border-radius: 8px; font-weight: 600; border: 0;
    font-family: inherit; font-size: 1rem; cursor: pointer;
  }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; }
  .steps { padding-left: 1.25rem; line-height: 1.7; }
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
    <p style="margin:0;color:var(--ink-soft);font-size:.875rem">
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
