import { formatMoney, type ActionRecord } from "@adeia/shared";

/**
 * Server-rendered HTML. No JavaScript, no external assets, no network calls
 * from the page — it has to render on a phone, on a locked-down corporate
 * network, in whatever browser the approver happens to be holding.
 */

/**
 * Every interpolated value goes through this. `description` is written by an
 * LLM, is influenceable by whatever the agent read, and lands in a human's
 * browser — it is untrusted input on the way to a privileged decision.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
  :root {
    --paper: #E9EBEE; --ink: #0B0E14; --ink-soft: #48505E;
    --rule: #C6CBD2; --surface: #FFFFFF;
    --held: #B3701C; --exec: #3F6A4C; --deny: #97362D;
    --bg: var(--paper); --fg: var(--ink);
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0B0E14; --fg: #E9EBEE; --ink-soft: #98A0AE;
            --rule: #2A303B; --surface: #141922; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 32rem; }
  .card {
    background: var(--surface); border: 1px solid var(--rule);
    border-radius: 12px; padding: 1.5rem;
  }
  .eyebrow {
    font-size: .75rem; letter-spacing: .08em; text-transform: uppercase;
    color: var(--ink-soft); margin: 0 0 .5rem;
  }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; line-height: 1.2; }
  .to { color: var(--ink-soft); margin: 0 0 1.5rem; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: .6rem 1rem; }
  dt { color: var(--ink-soft); font-size: .875rem; }
  dd { margin: 0; font-size: .875rem; word-break: break-word; }
  .reason {
    margin: 1.5rem 0 0; padding: .875rem 1rem; border-radius: 8px;
    background: color-mix(in srgb, var(--held) 12%, transparent);
    border-left: 3px solid var(--held); font-size: .875rem;
  }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  form { flex: 1; margin: 0; }
  button {
    width: 100%; padding: .8rem 1rem; font-size: 1rem; font-weight: 600;
    border-radius: 8px; border: 1px solid transparent; cursor: pointer;
    font-family: inherit;
  }
  .approve { background: var(--exec); color: #fff; }
  .deny { background: transparent; color: var(--deny); border-color: var(--deny); }
  .note { margin: 1.25rem 0 0; font-size: .8125rem; color: var(--ink-soft); }
  .status { font-size: 1.25rem; margin: 0 0 .5rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<!-- Approval links must never be prefetched or preloaded into a mutation. -->
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function row(label: string, value: string): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
}

/**
 * The decision page. Shows enough to decide without leaving it: amount,
 * recipient, description, which rule tripped, and which project asked.
 *
 * Both buttons are `method="POST"` submitting to the current URL. The token
 * stays in the path rather than a hidden field so it is never duplicated into
 * two places that could disagree.
 */
export function renderApprovalPage(
  action: ActionRecord,
  token: string,
  opts: { projectName?: string } = {},
): string {
  const amountCents = Number(action.params["amountCents"] ?? 0);
  const currency = String(action.params["currency"] ?? "usd");
  const recipient = String(action.params["recipient"] ?? "");
  const description = action.params["description"];

  const details = [
    row("Recipient", recipient),
    description ? row("Description", String(description)) : "",
    row("Project", opts.projectName ?? action.projectId),
    row("Requested", action.createdAt),
    row("Action", action.id),
  ].join("");

  // The action id is in the path already; posting to "" keeps the browser on
  // the exact URL it loaded, token included.
  const body = `
  <div class="card">
    <p class="eyebrow">Approval needed</p>
    <h1>${escapeHtml(formatMoney(amountCents, currency))}</h1>
    <p class="to">to ${escapeHtml(recipient)}</p>
    <dl>${details}</dl>
    <p class="reason">${escapeHtml(action.decisionReason ?? "This action requires approval.")}</p>
    <div class="actions">
      <form method="POST" action="">
        <input type="hidden" name="decision" value="approve">
        <button class="approve" type="submit">Approve</button>
      </form>
      <form method="POST" action="">
        <input type="hidden" name="decision" value="deny">
        <button class="deny" type="submit">Deny</button>
      </form>
    </div>
    <p class="note">This link can be used once. Nothing has been charged yet.</p>
  </div>`;

  return shell(`Approve ${formatMoney(amountCents, currency)} to ${recipient}`, body);
}

export function renderDecidedPage(decision: string, action?: ActionRecord | null): string {
  const approved = decision === "approve";
  const heading = approved ? "Approved" : "Denied";
  const detail = approved
    ? "The payment has been released and is executing now."
    : "The payment was refused. Nothing was charged.";

  const outcome = action
    ? `<dl>${row("Action", action.id)}${row("Status", action.status)}</dl>`
    : "";

  return shell(
    heading,
    `<div class="card">
      <p class="eyebrow">Decision recorded</p>
      <p class="status"><strong>${escapeHtml(heading)}</strong></p>
      <p class="to">${escapeHtml(detail)}</p>
      ${outcome}
      <p class="note">You can close this page.</p>
    </div>`,
  );
}

/** Used for a spent token, an expired one, and an unknown one — all are 410. */
export function renderExpiredPage(reason: string): string {
  return shell(
    "Link no longer valid",
    `<div class="card">
      <p class="eyebrow">Nothing to decide</p>
      <p class="status"><strong>This link is no longer valid</strong></p>
      <p class="to">${escapeHtml(reason)}</p>
      <p class="note">Approval links can be used once and expire. If this payment still
      needs to go through, ask for it to be requested again.</p>
    </div>`,
  );
}
