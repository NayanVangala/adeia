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

  /* ---------- the decision mark ----------
     The one rule this file opens with, made visible. A row that ran because
     a model judged it low risk must not look like a row a person approved,
     and until now that distinction lived only in a sentence of body copy.

     Steel is a model, amber is a person, and a bare hairline is the policy
     deciding on its own with nobody consulted — the three things that can
     actually put a row on this page. The colours are --machine and --person
     from tokens.css, which exist for exactly this and are used nowhere else
     in the dashboard, so the mark cannot be confused with decoration. */
  /* Drawn as a pseudo-element rather than a border, because a border cannot be
     animated and this mark has two things to say: who decided, and whether it
     is still your turn. */
  td.what-cell { position: relative; padding-left: 0.85rem; }
  td.what-cell::before {
    content: "";
    position: absolute; left: 0; top: 0; bottom: 0;
    width: 2px; border-radius: 1px;
    background: var(--rule);
    transform-origin: top;
    animation: mark-in 420ms var(--ease) both;
  }
  tr[data-decided="machine"] td.what-cell::before { background: var(--machine); }
  tr[data-decided="person"]  td.what-cell::before { background: var(--person); }

  /* Drawn down, in the order the rows are read. The stagger is capped by the
     nth-child list rather than computed, because a table this long is paged
     anyway and a typed delay here is one number, not a system. */
  @keyframes mark-in { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  tbody tr:nth-child(1) td.what-cell::before { animation-delay: 40ms; }
  tbody tr:nth-child(2) td.what-cell::before { animation-delay: 90ms; }
  tbody tr:nth-child(3) td.what-cell::before { animation-delay: 140ms; }
  tbody tr:nth-child(4) td.what-cell::before { animation-delay: 190ms; }
  tbody tr:nth-child(n+5) td.what-cell::before { animation-delay: 240ms; }

  /* The one row that is still your turn.

     Motion here is information, not decoration: an action waiting on a person
     is the only thing on this page that is still open, and it is the reason
     somebody opened the dashboard at all. It breathes slowly — 2.4s, a shift
     in opacity and nothing that moves — so it reads as alive in peripheral
     vision without pulling the eye off whatever is being read.

     Only pending_approval. An approved or denied row is finished and a mark
     that kept moving on it would be saying something untrue. */
  @keyframes mark-waiting {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.38; }
  }
  tr[data-decided="person"]:has(.decide) td.what-cell::before {
    animation: mark-in 420ms var(--ease) both, mark-waiting 2.4s ease-in-out 620ms infinite;
  }

  /* Affordance on the rows, so a dense feed responds to the pointer. Both are
     paint-only, which keeps a long table off the layout path. */
  tbody tr { transition: background var(--quick) var(--ease); }
  tbody tr:hover { background: color-mix(in srgb, var(--paper) 3%, transparent); }
  tbody tr:hover td.what-cell::before { filter: brightness(1.35); }

  @media (prefers-reduced-motion: reduce) {
    td.what-cell::before,
    tr[data-decided="person"]:has(.decide) td.what-cell::before {
      animation: none;
      transform: none;
    }
  }

  /* Stated once, above the first table, because a colour that means
     something has to say so somewhere. */
  .legend {
    display: flex; flex-wrap: wrap; gap: 1.25rem;
    margin: 0 0 0.85rem; padding: 0;
    list-style: none;
    font-size: var(--t-micro, 0.6875rem);
    letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--quiet);
  }
  .legend li { display: flex; align-items: center; gap: 0.5rem; }
  .legend i { width: 2px; height: 0.85em; border-radius: 1px; background: var(--rule); }
  .legend .is-machine i { background: var(--machine); }
  .legend .is-person i { background: var(--person); }

  /* ---------- pointer-reactive surfaces ----------
     cursor.js writes --mx/--my (a position on the card) and --tx/--ty (a
     direction from its middle) and leaves the page to decide what they mean.
     Here they mean a lamp held near the surface and a lean of well under a
     degree — at dashboard scale anything larger reads as a toy, and this is
     a page people check at 2am to find out what their agent did.

     Both default to the resting value, so a card is correct before the
     pointer has ever touched it and stays correct if the script never
     loads. */
  .card {
    position: relative;
    transform: perspective(900px)
      rotateX(calc(var(--ty, 0) * -0.5deg))
      rotateY(calc(var(--tx, 0) * 0.5deg));
    transition: transform var(--quick, 260ms) var(--ease, ease);
  }
  .card::after {
    content: "";
    position: absolute; inset: 0;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity var(--quick, 260ms) var(--ease, ease);
    background: radial-gradient(
      20rem circle at var(--mx, 50%) var(--my, 50%),
      rgba(229, 164, 75, 0.06),
      transparent 68%
    );
  }
  .card:hover::after { opacity: 1; }

  /* The masthead rule carries the gradient the rest of Adeia is built on —
     cold at the left, warm at the right, the same axis the marks below use. */
  header.bar { border-bottom: 0; position: relative; }
  header.bar::after {
    content: "";
    position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
    background: var(--sweep);
    opacity: 0.55;
  }

  /* Revealed rows start displaced. Without the script they never move, so
     the resting state has to be the readable one. */
  [data-reveal] { opacity: 1; }

  /* ---------- the fence, on the signed-out page only ----------
     The same canvas that closes the marketing site: strokes that stand
     aside for a pointer and close behind it. It is the one picture of what
     Adeia does, so it belongs on the page where somebody is deciding
     whether to find out — and nowhere near the signed-in dashboard, where
     the content is real and an ambient animation behind live figures is
     just something moving while you are trying to read.

     Fixed to the bottom of the viewport rather than to the document, so it
     stays the floor of the page instead of scrolling away from it. */
  .field {
    position: fixed;
    inset: auto 0 0;
    z-index: 0;
    width: 100%;
    height: min(42vh, 20rem);
    pointer-events: none;
  }
  /* Every content block states its layer explicitly.

     .card is position:relative for its sheen, and the canvas is positioned
     too and comes later in the document, so with both on auto the paint order
     is document order: the fence drew straight through the card and across
     the sign-in button. Stacking is not something to leave implicit on a page
     carrying a full-width canvas. */
  header.bar, main > h1, main > .lede, main > .card, .outcomes {
    position: relative;
    z-index: 1;
  }

  /* ---------- the signed-in page ----------
     Same language as the way in: rules, not boxes. Every section here used to
     be a bordered panel on a dark ground, which is four boxes stacked down a
     page and the reason it read as generated. A border groups things; these
     sections are already grouped by the heading above them.

     What carries structure instead is the hairline and the eyebrow, and the
     one thing set in colour is the thing that decided. */
  .proj {
    font-family: var(--mono);
    font-weight: 500;
    color: var(--paper);
    font-size: clamp(1.6rem, 1rem + 2.2vw, 2.4rem);
    letter-spacing: -0.03em;
    margin: 0 0 .35rem;
  }

  .panel {
    display: block;
    background: none;
    border: 0;
    border-top: 1px solid var(--hair);
    border-radius: 0;
    padding: 1.35rem 0 0;
    margin: 2.5rem 0 0;
  }
  /* No exception after all. A filled slab with a pill inside it was the most
     generated-looking thing left on the page, and it dominated a section that
     is one sentence and one control. The key gets emphasis from the mono
     block it is printed in, not from a box around the paragraph. */
  .panel--key { border-top: 1px solid var(--hair); }

  /* Buttons on this page follow the way in: type over a hairline, an arrow
     that moves, no filled ground. */
  .btn {
    display: inline-flex; align-items: center; gap: .5rem;
    min-height: 44px; padding: .5rem 0;
    background: none; border: 0; border-bottom: 1px solid var(--hair-lit);
    border-radius: 0; color: var(--paper);
    font-family: inherit; font-size: 1rem; font-weight: 500;
    letter-spacing: 0; text-transform: none; cursor: pointer;
    transition: color var(--quick) var(--ease), border-color var(--quick) var(--ease);
  }
  .btn:hover { color: var(--person); border-bottom-color: var(--person); }
  .btn:focus-visible { outline: 2px solid var(--paper); outline-offset: 4px; }

  /* A caution, not an alert. The cream slab was a light box punched into a
     dark page and read as a browser dialog rather than as this product. */
  .warn {
    margin: 1rem 0 0; padding: 0 0 0 .9rem;
    background: none; border: 0; border-left: 2px solid var(--person);
    color: var(--muted); font-size: var(--t-small);
  }

  /* Clear of the stats above it, which it had collided into. */
  .legend { margin: 2.25rem 0 0; }

  /* Rows are not animated at all, so nothing can leave one blank. reveal.js
     hides a [data-reveal] element by inline style and animates it back, and a
     finished animation without a forwards fill reverts to that inline zero —
     which is a row of the audit trail going invisible after it arrived. It is
     also the wrong instinct: a table of what your agent just did should be
     readable the instant it is on screen, not staggered in while you are
     trying to read it. */

  /* Sections are separated by their heading and a rule, so the tables carry
     no chrome of their own. */
  table.feed { width: 100%; border-collapse: collapse; }
  table.feed thead th {
    text-align: left; font-weight: 500;
    font-size: var(--t-micro); letter-spacing: .08em; text-transform: uppercase;
    color: var(--faint); padding: 0 0 .6rem;
    border-bottom: 1px solid var(--hair);
  }
  table.feed td { padding: .95rem 0; border-bottom: 1px solid var(--hair); vertical-align: top; }
  table.feed tr:last-child td { border-bottom: 0; }
  .empty { color: var(--faint); font-size: var(--t-small); margin: .25rem 0 0; }

  /* Numbers read as numbers: mono, large, and the label small under it. */
  .stats { display: flex; flex-wrap: wrap; gap: clamp(1.75rem, 5vw, 3.5rem); margin: 2rem 0 0; }
  .stat-n {
    font-family: var(--mono); font-weight: 500;
    font-size: clamp(1.5rem, 1rem + 1.4vw, 2rem);
    letter-spacing: -.02em; line-height: 1.1;
  }
  .stat-l {
    font-size: var(--t-micro); letter-spacing: .08em; text-transform: uppercase;
    color: var(--faint); margin-top: .3rem;
  }

  h2 {
    font-family: var(--mono); font-weight: 500;
    font-size: var(--t-small); letter-spacing: .04em;
    color: var(--muted);
    margin: 2.75rem 0 .9rem;
  }

  /* ---------- projects ---------- */
  .switch { display: flex; flex-wrap: wrap; gap: 1.5rem; margin: 0 0 1.5rem; }
  .switch-item {
    font-family: var(--mono); font-size: var(--t-small);
    color: var(--faint); text-decoration: none;
    padding-bottom: .35rem; border-bottom: 1px solid transparent;
    transition: color var(--quick) var(--ease), border-color var(--quick) var(--ease);
  }
  .switch-item:hover { color: var(--muted); }
  .switch-item.is-on { color: var(--paper); border-bottom-color: var(--person); }

  .rename { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin: 0; }
  .rename .proj { margin: 0; }
  .rename-input {
    /* Visible by default, hidden only under .js. The other way round leaves a
       browser without JavaScript showing a Save button above a field it cannot
       see — and this file's premise is that the dashboard works without
       scripts at all. */
    display: inline-block;
    font-family: var(--mono); font-weight: 500;
    font-size: clamp(1.6rem, 1rem + 2.2vw, 2.4rem);
    letter-spacing: -0.03em;
    color: var(--paper); background: none;
    border: 0; border-bottom: 1px solid var(--hair-lit);
    padding: 0 0 .1rem; min-width: 12ch; max-width: 100%;
  }
  .rename-input:focus { outline: none; border-bottom-color: var(--person); }
  .btn--sm { min-height: 32px; font-size: var(--t-small); }
  /* Save and Cancel are only meaningful once the field is open. Hidden by a
     class the script adds, so with JavaScript off the field and Save are both
     visible and renaming works as an ordinary form post. */
  .js .rename-input { display: none; }
  .js .rename [type="submit"], .js .rename-cancel { display: none; }
  .js .rename.is-open .rename-input { display: inline-block; }
  .js .rename.is-open [type="submit"], .js .rename.is-open .rename-cancel { display: inline-flex; }
  .js .rename.is-open [data-rename-label], .js .rename.is-open .rename-open { display: none; }
  .rename-open { display: none; }
  .js .rename-open { display: inline-flex; }
  /* Without scripts the field is the name, so the static heading beside it
     would be the same text twice. */
  html:not(.js) .rename [data-rename-label] { display: none; }

  .newproj { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin: 1.25rem 0 0; }
  .newproj-input {
    background: none; color: var(--paper);
    border: 0; border-bottom: 1px solid var(--hair);
    padding: .45rem 0; min-width: 16ch;
    font-family: inherit; font-size: var(--t-small);
  }
  .newproj-input::placeholder { color: var(--faint); }
  .newproj-input:focus { outline: none; border-bottom-color: var(--person); }

  .switch-item.is-archived { opacity: .55; }
  .switch-item.is-archived::after { content: " (archived)"; font-size: var(--t-micro); }

  .archived-note {
    margin: 1rem 0 0; padding: 0 0 0 .9rem;
    border-left: 2px solid var(--machine);
    color: var(--muted); font-size: var(--t-small); max-width: 58ch;
  }
  .rowform { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin: 1.25rem 0 0; }
  .rowform-note { color: var(--faint); font-size: var(--t-small); }

  /* ---------- press feedback ----------
     A form here posts, waits on a database on the other side of the country,
     and comes back as a whole new page. That is a second or two where the only
     honest thing the interface can say is "I heard you" — and it was saying
     nothing, which reads as a button that does not work and gets pressed
     again.

     Two layers. :active is instant and needs no script at all: the control
     moves under the finger on mousedown, before any request exists. The busy
     state then holds until the new page replaces this one. */
  .btn:active, .enter:active, .decide button:active, .newproj button:active {
    transform: translateY(1px);
  }
  .btn, .enter, .decide button, .newproj button {
    transition:
      transform 90ms var(--ease),
      color var(--quick) var(--ease),
      border-color var(--quick) var(--ease),
      opacity var(--quick) var(--ease);
  }

  /* Held from submit until navigation. The label is replaced rather than
     decorated, because a spinner beside unchanged text still reads as the
     same button sitting there. */
  [data-busy] {
    opacity: .62;
    cursor: progress;
    pointer-events: none;
  }
  [data-busy]::after {
    content: "";
    display: inline-block;
    width: .55em; height: .55em;
    margin-left: .55em;
    border-radius: 50%;
    background: currentColor;
    animation: busy-pulse 900ms ease-in-out infinite;
  }
  @keyframes busy-pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }

  @media (prefers-reduced-motion: reduce) {
    .btn:active, .enter:active, .decide button:active, .newproj button:active { transform: none; }
    [data-busy]::after { animation: none; opacity: .7; }
  }

  /* ---------- the first call ---------- */
  /* --faint, not --hair-lit. hair-lit is a border token and using it as an
     ink puts text at roughly 1.5:1 on this ground — the same defect this
     session already found on the approval page. Every ink in tokens.css
     states its measured contrast; the border values do not, because they
     were never meant to be read. */
  .panel-dim { color: var(--faint); }
  .panel-lede { margin: 0 0 1rem; color: var(--muted); font-size: var(--t-small); max-width: 58ch; }
  .panel-note { margin: .9rem 0 0; color: var(--faint); font-size: var(--t-small); max-width: 58ch; }
  .panel-note code { font-family: var(--mono); color: var(--muted); }

  /* Scrolls rather than wraps. A wrapped shell command is a command that
     fails when it is pasted, and this one exists to be pasted. */
  .snippet {
    margin: 0 0 1rem;
    padding: 1rem 1.1rem;
    background: var(--near);
    border: 1px solid var(--hair);
    border-radius: var(--radius-sm);
    overflow-x: auto;
    font-family: var(--mono);
    font-size: .8125rem;
    line-height: 1.7;
    color: var(--muted);
    white-space: pre;
  }
  .snippet code { font-family: inherit; font-size: inherit; color: inherit; }

  /* Confirms in place. A copy control that says nothing after a click leaves
     you clicking it again to find out whether the first one worked. */
  .btn[data-copied] { color: var(--ran); border-bottom-color: var(--ran); }

  /* ---------- the signed-out page ----------
     A ledger, not a form. The product's output is a record of what an agent
     asked and what happened, so the page that introduces it is set as one:
     rules instead of boxes, amounts in a column you read down, and the
     display face in mono because mono here marks a value a machine used.

     Laid out as two columns on anything wide enough. The argument sits left
     and the evidence sits right, which stops the page being a single stack of
     blocks with the fold's worth of black underneath it. */
  body:has(.field) {
    display: block;
    padding: 0 var(--gutter) 0;
  }
  body:has(.field) main {
    max-width: 68rem;
    min-height: 100vh;
    min-height: 100svh;
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto;
    align-content: start;
    gap: 0;
    padding-bottom: min(40vh, 18rem);
  }

  .signin-h1 {
    /* Stated, because the base h1 in this sheet is an accent colour and would
       make the whole headline amber — which loses the one distinction the
       line is built on. Bone for what the product is, amber for what it
       promises, matching what amber means everywhere else here. */
    color: var(--paper);
    font-family: var(--mono);
    font-weight: 500;
    font-size: clamp(1.9rem, 1rem + 3.4vw, 3.4rem);
    line-height: 1.08;
    letter-spacing: -0.03em;
    margin: clamp(2rem, 8vh, 5rem) 0 0;
    max-width: 18ch;
  }
  /* The second line is the promise, and it is the warm end of the gradient —
     the same colour the dashboard uses for a decision a person made. */
  .signin-h1 em { font-style: normal; color: var(--person); }

  .signin-lede {
    margin: 1.25rem 0 0;
    max-width: 34ch;
    color: var(--muted);
    font-size: var(--t-body);
  }

  .ledger { margin: clamp(2.5rem, 7vh, 4rem) 0 0; }
  .ledger-row {
    display: grid;
    grid-template-columns: minmax(6.5rem, auto) minmax(4.5rem, auto) 1fr;
    align-items: baseline;
    gap: 1.25rem;
    padding: .95rem 0;
    border-top: 1px solid var(--hair);
  }
  .ledger-row:last-child { border-bottom: 1px solid var(--hair); }
  .ledger-row b {
    font-family: var(--mono); font-weight: 500;
    font-size: 1.0625rem; letter-spacing: -.01em;
  }
  .ledger-row i {
    font-style: normal; font-weight: 600;
    font-size: var(--t-small); letter-spacing: .02em;
  }
  .ledger-row span { color: var(--faint); font-size: var(--t-small); }
  .ledger-row .ran { color: var(--ran); }
  .ledger-row .held { color: var(--person); }
  .ledger-row .no { color: var(--hot); }

  /* The way in. A rule under a line of type rather than a filled pill: the
     pill is the part that read as generated, and nothing else on this page
     is a solid block of colour. */
  .enter {
    display: inline-flex; align-items: center; gap: .6rem;
    margin: clamp(2rem, 6vh, 3.25rem) 0 0;
    padding: .55rem 0;
    min-height: 44px;
    font-size: 1.0625rem; font-weight: 500;
    color: var(--paper); text-decoration: none;
    border-bottom: 1px solid var(--hair-lit);
    transition: color var(--quick) var(--ease), border-color var(--quick) var(--ease);
  }
  .enter svg { transition: transform var(--quick) var(--ease); }
  .enter:hover { color: var(--person); border-bottom-color: var(--person); }
  .enter:hover svg { transform: translateX(4px); }
  .enter:focus-visible { outline: 2px solid var(--paper); outline-offset: 4px; }

  .enter-note {
    margin: .9rem 0 0; max-width: 42ch;
    color: var(--faint); font-size: var(--t-small);
  }
  .enter-note code { font-family: var(--mono); color: var(--muted); }

  @media (min-width: 56rem) {
    body:has(.field) main {
      grid-template-columns: 1.05fr 1fr;
      grid-template-rows: auto auto;
      column-gap: clamp(3rem, 7vw, 6rem);
      align-content: center;
      padding-bottom: min(34vh, 16rem);
    }
    header.bar { grid-column: 1 / -1; }
    .signin-h1 { grid-column: 1; margin-top: 0; }
    .signin-lede { grid-column: 1; }
    .enter, .enter-note { grid-column: 1; }
    /* The evidence column, aligned to the headline's optical top. */
    .ledger { grid-column: 2; grid-row: 2 / span 4; margin-top: .35rem; align-self: start; }
  }

  @media (prefers-reduced-motion: reduce) {
    .card { transform: none; }
    .card::after { display: none; }
  }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/styles/cursor.css">
<style>${STYLE}</style>
</head>
<body><main>${body}</main>
<!-- Enhancement, loaded after the document and never depended on. Every
     effect these add is absent under prefers-reduced-motion and on a device
     without a hovering pointer, which is the same judgement the marketing
     site makes. The dashboard is complete without any of them. -->
<script src="/vendor/motion.js" defer></script>
<script src="/cursor.js" type="module"></script>
<script src="/reveal.js" type="module"></script>
<script src="/fence.js" type="module"></script>
<script>
/* Copy, with a spoken result.

   Enhancement: without it the command is still selectable text, which is how
   anyone copied anything before this existed. The label says what happened
   and puts itself back, so the control never sits in a state that lies. */
(function () {
  for (const b of document.querySelectorAll("[data-copy]")) {
    b.addEventListener("click", function () {
      const src = document.getElementById(b.dataset.copy);
      if (!src || !navigator.clipboard) return;
      navigator.clipboard.writeText(src.textContent).then(
        function () {
          b.textContent = "Copied";
          b.setAttribute("data-copied", "");
          setTimeout(function () {
            b.textContent = "Copy";
            b.removeAttribute("data-copied");
          }, 1600);
        },
        function () { b.textContent = "Press Cmd-C"; },
      );
    });
  }

  /* Marks the document so CSS can hide the controls that only make sense once
     the field is open. Set from script rather than in the markup, so a browser
     with JavaScript off never hides anything and renaming stays an ordinary
     form with a visible input and a Save button. */
  document.documentElement.classList.add("js");

  /* Every form that posts says so the moment it is submitted.

     The button is NOT disabled — a disabled control is dropped from the
     submitted payload, and these buttons carry names the routes read. It is
     made inert with pointer-events instead, which stops a second press
     without changing what gets sent. That matters most on Approve, where a
     double press is a second attempt at something irreversible.

     Bound on submit rather than click so it fires for Enter in a text field
     too, and so a form that fails validation never gets stuck saying busy. */
  for (const form of document.querySelectorAll("form[method='POST' i]")) {
    form.addEventListener("submit", function () {
      const b = form.querySelector("button[type='submit'], button:not([type])");
      if (!b || b.hasAttribute("data-busy")) return;
      b.setAttribute("data-busy", "");
      const verb = (b.textContent || "").trim();
      b.textContent =
        verb === "Approve" || verb.startsWith("Confirm") ? "Approving" :
        verb === "Deny" ? "Denying" :
        verb === "Allow" ? "Allowing" :
        verb === "Save" ? "Saving" :
        verb === "Create project" ? "Creating" :
        verb === "Generate a new key" ? "Generating" :
        verb === "Archive project" ? "Archiving" :
        verb === "Restore project" ? "Restoring" :
        verb === "Remove" ? "Removing" :
        verb === "Sign out" ? "Signing out" : "Working";
    });
  }

  const form = document.querySelector(".rename");
  if (form) {
    const open = form.querySelector("[data-rename-open]");
    const cancel = form.querySelector("[data-rename-cancel]");
    const input = form.querySelector(".rename-input");
    const original = input ? input.value : "";
    if (open) open.addEventListener("click", function () {
      form.classList.add("is-open");
      if (input) { input.focus(); input.select(); }
    });
    if (cancel) cancel.addEventListener("click", function () {
      form.classList.remove("is-open");
      if (input) input.value = original;
    });
    form.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && cancel) cancel.click();
    });
  }
})();
</script>
<script type="module">
/* The entrance, on Motion.

   Everything here is above the fold, so an inView reveal would fire all of it
   at once and be indistinguishable from no animation. This is a load sequence
   instead: masthead, then heading, then the card, then the three outcomes in
   a computed stagger. Springs rather than curves, matching reveal.js on the
   marketing site.

   The resting state is committed explicitly when each animation finishes.
   An element is hidden here by an inline style, and a finished animation
   without a forwards fill reverts to exactly that — so the sequence ran and
   then put everything back to invisible. Committing on the finished promise makes the
   end state a fact rather than a side effect of fill mode.

   The timeout underneath is the floor, not the mechanism: this page is the
   only way into the product, and it does not get to depend on an animation
   library resolving. A visitor who sees no entrance is fine. A visitor who
   sees nothing is not. */
const M = window.Motion;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (M && !reduced) {
  /* Both pages run this shell, so the list covers both and empty groups drop
     out. Order is reading order, not document order. */
  const groups = [
    document.querySelectorAll("header.bar"),
    document.querySelectorAll(".signin-h1, main > h1, main > .lede, .signin-lede"),
    document.querySelectorAll(".ledger-row, main > .card"),
    document.querySelectorAll(".enter, .enter-note"),
  ].filter((g) => g.length);

  const settle = (g) => {
    for (const el of g) {
      el.style.opacity = "1";
      el.style.transform = "none";
    }
  };

  for (const g of groups) for (const el of g) el.style.opacity = "0";

  const running = [];
  let at = 0;
  for (const g of groups) {
    const anim = M.animate(
      g,
      { opacity: [0, 1], transform: ["translateY(14px)", "translateY(0px)"] },
      { type: "spring", stiffness: 180, damping: 24, mass: 0.9,
        delay: M.stagger(0.05, { startDelay: at }) },
    );
    running.push([anim, g]);
    Promise.resolve(anim && anim.finished).then(() => settle(g)).catch(() => settle(g));
    at += 0.09;
  }

  /* The floor has to cancel before it sets, not merely set. A running
     animation wins over an inline style in the cascade, so writing
     opacity:1 underneath one that is stuck near zero changes the attribute
     and nothing a visitor can see — which is precisely the state this was
     written to rescue.

     Stuck happens: a tab opened in the background throttles rAF, and the
     spring sits unfinished until the tab is looked at. That case does
     resolve on its own, but "opened in a new tab" is how a fair number of
     people will arrive here from a link, and the page is not allowed to be
     blank for any of them. */
  setTimeout(() => {
    for (const [anim, g] of running) {
      try { if (anim && anim.cancel) anim.cancel(); } catch (e) {}
      settle(g);
    }
  }, 2000);
}
</script>
</body>
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
  /** Which project this page is about. Carried on every form that changes it. */
  projectId: string;
  /** Set while this project is archived: its key no longer authenticates. */
  projectArchivedAt: string | null;
  /** Everything this user owns, for the switcher. */
  projects: { id: string; name: string; archived: boolean }[];
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
  /**
   * Where this deployment answers. Printed into the first-call snippet so the
   * command a new project copies is one that runs, rather than one with a
   * placeholder host they have to know to replace.
   */
  baseUrl: string;
}

/**
 * The host allowlist, editable.
 *
 * A new project starts empty, which denies every outbound call. That is the
 * right default — guessing which hosts a stranger trusts is not something to
 * do for them — but it is only defensible if changing it takes one field. An
 * empty list with no way to edit it is not a safe default, it is a dead end.
 */
function hostsCard(hosts: string[], csrf: string, projectId: string): string {
  /* projectId travels with every host edit.
   
     Without it the route falls back to the caller's first project, so editing
     the allowlist while looking at a second one silently edited the first —
     the form said one thing and the database did another, with no error to
     notice. Every form that changes a project has to name which project. */
  const field =
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<input type="hidden" name="projectId" value="${escapeHtml(projectId)}">`;

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

  return `<section class="panel">
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
  </section>`;
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

  /* Who put this row on the page. A person outranks a model: once something
     is waiting on you or you have approved it, the model's opinion is no
     longer what decided it. Everything else got here because the policy
     answered on its own, with nobody asked — which is the common case and
     should look like the quiet one. */
  const decided =
    action.status === "pending_approval" || action.status === "approved"
      ? "person"
      : entry.classifier !== null
        ? "machine"
        : "policy";

  const decidedLabel = {
    person: "Decided by you",
    machine: "Judged by a model",
    policy: "Decided by your policy",
  }[decided];

  return `<tr data-decided="${decided}">
    <td class="what-cell" title="${decidedLabel}">
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
    ? `<section class="panel panel--key">
      <p class="eyebrow">Your API key</p>
      <p style="margin:0">This is the only time it is shown. Adeia stores a hash, not the key,
      so it cannot be shown again — but you can generate a new one whenever you want.</p>
      <div class="key">${escapeHtml(view.freshApiKey)}</div>
      <p class="warn">Anyone holding this key can ask Adeia to act inside your policy.
      Keep it out of screenshots and out of git.</p>
    </section>`
    : `<section class="panel panel--key">
      <p class="eyebrow">API key</p>
      <p style="margin:0 0 .75rem">Your agents authenticate with a key. Adeia only stores a
      hash of it, so an existing key can never be shown again — generating a new one is the
      way to get a key you can read.</p>
      <form method="POST" action="/dashboard/key" style="margin:0">
        <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
        <input type="hidden" name="projectId" value="${escapeHtml(view.projectId)}">
        <button class="btn" type="submit">Generate a new key</button>
      </form>
      <p class="warn">This replaces the current key immediately. Anything already using
      the old one stops working until you paste in the new one.</p>
    </section>`;

  /**
   * The first call, printed ready to run.
   *
   * A new project used to arrive at "point an agent at Adeia with your API
   * key and they will show up here" — which says what to do and nothing about
   * how, to somebody holding a key and no idea where it goes. This is the
   * whole gap between signing up and using the thing.
   *
   * curl rather than the SDK, because the SDK is not on npm yet and a
   * language-specific snippet is wrong for most of the people reading it.
   * $25 rather than $500, because it is under the per-action limit and
   * therefore executes: the point is to see something land in the trail
   * below, not to send yourself an approval email on your first minute.
   *
   * The key is only in the command when it is the one moment it can be —
   * `freshApiKey` is set once, right after provisioning. Afterwards the
   * snippet carries a placeholder, because Adeia stores a hash and genuinely
   * cannot print the key again.
   */
  const firstCall = view.actions.length > 0 ? "" : `
    <section class="panel">
      <p class="eyebrow">Your first call</p>
      <p class="panel-lede">Run this and it lands in the trail below. It is $25, which is
      under your $50 limit, so Adeia executes it rather than asking you about it.</p>
      <pre class="snippet"><code id="first-call">curl -X POST ${escapeHtml(view.baseUrl)}/v1/actions \\
  -H "authorization: Bearer ${escapeHtml(view.freshApiKey ?? "YOUR_API_KEY")}" \\
  -H "content-type: application/json" \\
  -d '{"type":"payment","idempotencyKey":"'$(uuidgen)'","params":{"amountCents":2500,"currency":"usd","recipient":"acct_example"}}'</code></pre>
      <button class="btn" type="button" data-copy="first-call">Copy</button>
      <p class="panel-note">Then reload this page. Try it again with
      <code>"amountCents":50000</code> and it stops and emails you instead.
      <br><span class="panel-dim">The idempotency key is what stops a retry becoming
      a second payment — send the same one twice and you get the same action back,
      which is why the command generates a fresh one each run.</span></p>
    </section>`;

  const table = (rows: DashboardAction[], emptyText: string): string =>
    rows.length === 0
      ? `<p class="empty">${escapeHtml(emptyText)}</p>`
      : `<table class="feed">
          <thead><tr><th>What</th><th>State</th><th>When</th></tr></thead>
          <tbody>${rows.map((r) => actionRow(r, view.csrf)).join("")}</tbody>
        </table>`;

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

  ${
    view.projects.length > 1
      ? `<nav class="switch" aria-label="Projects">${view.projects
          .map(
            (p) =>
              `<a class="switch-item${p.id === view.projectId ? " is-on" : ""}${p.archived ? " is-archived" : ""}"
                  href="/dashboard?p=${encodeURIComponent(p.id)}"
                  ${p.id === view.projectId ? 'aria-current="page"' : ""}
               >${escapeHtml(p.name)}</a>`,
          )
          .join("")}</nav>`
      : ""
  }

  <!-- The heading is the name, and editing it happens in place: a separate
       settings page for one text field is a page nobody would find. Without
       JavaScript this is a visible text input and a Save button, which is the
       whole feature; with it, the input only appears once you ask. -->
  <form class="rename" method="POST" action="/dashboard/project/rename">
    <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
    <input type="hidden" name="projectId" value="${escapeHtml(view.projectId)}">
    <h1 class="proj" data-rename-label>${escapeHtml(view.projectName)}</h1>
    <input class="rename-input" name="name" value="${escapeHtml(view.projectName)}"
           maxlength="60" aria-label="Project name">
    <button class="btn btn--sm" type="submit">Save</button>
    <button class="btn btn--sm rename-cancel" type="button" data-rename-cancel>Cancel</button>
    <button class="btn btn--sm rename-open" type="button" data-rename-open>Rename</button>
  </form>

  <p class="lede">Everything your agents asked to do, and what Adeia did about it.</p>

  ${
    view.projectArchivedAt
      ? `<p class="archived-note">Archived ${escapeHtml(when(view.projectArchivedAt))}.
         Its key no longer authenticates, so nothing can act as this project.
         Everything below is still here.</p>`
      : ""
  }

  <form class="rowform" method="POST" action="/dashboard/project/archive">
    <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
    <input type="hidden" name="projectId" value="${escapeHtml(view.projectId)}">
    ${view.projectArchivedAt ? `<input type="hidden" name="restore" value="1">` : ""}
    <button class="btn btn--sm" type="submit">${
      view.projectArchivedAt ? "Restore project" : "Archive project"
    }</button>
    ${
      view.projectArchivedAt
        ? ""
        : `<span class="rowform-note">Stops its key working. Keeps every record.</span>`
    }
  </form>

  <form class="newproj" method="POST" action="/dashboard/project/new">
    <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
    <input class="newproj-input" name="name" placeholder="New project name" maxlength="60"
           aria-label="New project name">
    <button class="btn btn--sm" type="submit">Create project</button>
  </form>

  ${flash}
  ${keyBlock}
  ${firstCall}

  <div class="stats">
    <div><div class="stat-n">${view.counts.waiting}</div><div class="stat-l">waiting on you</div></div>
    <div><div class="stat-n">${view.counts.ranToday}</div><div class="stat-l">ran today</div></div>
    <div><div class="stat-n">${view.counts.refusedToday}</div><div class="stat-l">refused today</div></div>
  </div>

  <ul class="legend">
    <li class="is-person"><i></i> you decided</li>
    <li class="is-machine"><i></i> a model judged</li>
    <li><i></i> your policy decided</li>
  </ul>

  <h2>Waiting on you</h2>
  ${table(waiting, "Nothing is waiting. Adeia will email you when something needs a decision.")}

  <h2>Recent activity</h2>
  ${table(rest, "No actions yet. Point an agent at Adeia with your API key and they will show up here.")}

  <h2>Policy</h2>
  ${hostsCard(view.allowedHosts, view.csrf, view.projectId)}
  `;

  return shell(`${view.projectName} — Adeia`, body);
}

/** Shown to a signed-out visitor. */
export function renderSignIn(configured: boolean): string {
  /* No card.

     A centred panel on a near-black page with a filled accent button is the
     house style of every generated landing page of the last two years, which
     tokens.css opens by refusing. Boxing the only content on a page also says
     nothing: a border groups things, and there is one thing here.

     What replaced it is the shape the product actually makes — a ledger. Rules
     rather than boxes, the display face in mono because mono here marks a
     value a machine used, and the amounts in a column you can read down. */
  const body = `
  <header class="bar"><p class="wordmark">Adeia</p></header>

  <h1 class="signin-h1">Agents that act,<br><em>inside a fence you set.</em></h1>

  <p class="signin-lede">Your agent asks before it spends. Small things run.
  Anything over your limit stops and waits for you.</p>

  <section class="ledger" aria-label="What happens at three amounts">
    <div class="ledger-row">
      <b>$25</b><i class="ran">runs</i><span>inside the limit you set</span>
    </div>
    <div class="ledger-row">
      <b>$500</b><i class="held">waits</i><span>emails you, and the agent stops until you answer</span>
    </div>
    <div class="ledger-row">
      <b>$9,999,999</b><i class="no">refused</i><span>over your hard maximum, and it says so</span>
    </div>
  </section>

  ${
    configured
      ? `<a class="enter" data-magnet href="/auth/github">
           <span>Sign in with GitHub</span>
           <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none"
                stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
             <path d="M5 12h13M12 5l7 7-7 7"/>
           </svg>
         </a>
         <p class="enter-note">Asks for <code>read:user</code>. Never your repositories.
         You get a project and an API key on the way in.</p>`
      : `<p class="enter-note">Sign-in is not configured on this deployment.</p>`
  }

  <canvas class="field" data-fence aria-hidden="true"></canvas>`;
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
