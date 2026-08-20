/**
 * Adeia — the count before the page.
 *
 * A loading screen that lies is worse than none: a fixed two-second
 * timer is a two-second tax on somebody who was ready in three hundred
 * milliseconds. This one is driven by real readiness — the variable
 * fonts, the vendored Motion bundle, and window load — and it eases
 * toward whatever fraction of those has actually landed. It can run
 * ahead of the truth, because a counter that stalls reads as broken,
 * but it cannot reach 100 before the page has.
 *
 * It is also capped. If something never resolves, it finishes anyway
 * rather than holding the site hostage to one font file.
 *
 * Shown once a session. A loader on every internal navigation is a
 * loader nobody wants by the third page.
 *
 * The overlay is inert to assistive technology throughout — the page
 * beneath it is complete and readable the whole time — and it is
 * removed from the document when it leaves rather than left covering
 * the page with pointer-events off.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const KEY = "adeia:seen-loader";

/* Whatever happens, it is gone by this — measured from navigation, not
   from when this file happens to run. It is a module, so it does not
   execute until the classic scripts before it have downloaded; on a slow
   connection that is seconds, and a ceiling started here would promise
   four and deliver nine. */
const CEILING_MS = 5000;

const sinceNavigation = () => {
  const nav = performance.getEntriesByType("navigation")[0];
  return nav ? performance.now() - nav.startTime : performance.now();
};

const el = document.querySelector("[data-loader]");

if (el) {
  const seen = sessionStorage.getItem(KEY);
  if (seen || reduced.matches) {
    el.remove();
    document.documentElement.classList.remove("is-loading");
  } else {
    sessionStorage.setItem(KEY, "1");
    run(el);
  }
}

function run(el) {
  const num = el.querySelector("[data-loader-num]");
  const bar = el.querySelector("[data-loader-bar]");
  const M = window.Motion;

  /* The real signals. Each one that lands moves the target. */
  let landed = 0;
  const signals = [
    document.fonts ? document.fonts.ready : Promise.resolve(),
    new Promise((r) =>
      document.readyState === "complete"
        ? r()
        : window.addEventListener("load", r, { once: true }),
    ),
    /* Motion is a classic script, so by the time this module runs it has
       either loaded or failed. Resolved either way — this is a progress
       signal, not a gate. */
    Promise.resolve(),
  ];
  const total = signals.length;
  for (const s of signals) s.then(() => (landed += 1)).catch(() => (landed += 1));

  let shown = 0;
  let done = false;
  let started = 0;

  const finish = () => {
    if (done) return;
    done = true;
    out(el, M);
  };

  const ceiling = setTimeout(finish, Math.max(400, CEILING_MS - sinceNavigation()));

  function frame(now) {
    if (!started) started = now;
    const elapsed = now - started;

    /* Where the truth is. */
    const real = landed / total;

    /* Where the count is allowed to be. It runs ahead of `real` on a
       curve that decelerates, so it always feels like it is moving even
       while a font is still in flight — but it is clamped just under
       the next real milestone, so it never claims more than has
       happened. */
    const drift = 1 - Math.exp(-elapsed / 620);

    /* The 0.96 ceiling is what holds the count back while anything is
       still in flight — a loader that shows 100 and then sits there is
       the thing everyone hates. But it has to lift the moment the page
       is genuinely ready, or the finish condition below can never be
       true and the four-second fallback becomes the only way out. That
       is exactly what it was: a fixed timer wearing a progress bar. */
    const target = real === 1 ? 1 : Math.min(drift * 0.96, real + 0.24);

    shown += (target - shown) * 0.12;
    /* Exponential easing approaches its target and never lands on it, so
       the last fraction of a percent would take forever. */
    if (target - shown < 0.004) shown = target;

    const pct = Math.min(100, Math.round(shown * 100));
    num.textContent = String(pct).padStart(3, "0");
    bar.style.transform = `scaleX(${(shown).toFixed(4)})`;

    if (real === 1 && pct >= 100) {
      clearTimeout(ceiling);
      /* A beat on 100, so it reads as arriving rather than as a number
         that happened to stop. */
      setTimeout(finish, 260);
      return;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

/**
 * The way out.
 *
 * The two halves part at the rule and the page is behind the gap. That
 * is the product's own picture — a fence with one gap in it — rather
 * than a wipe chosen because it looked nice.
 *
 * The order matters. The count goes first, so the panel is empty before
 * it moves and nothing is read while sliding. The seam flares, because
 * the gap opening is the moment. Then the halves part, the top a beat
 * before the bottom, so the two do not read as one slab splitting.
 *
 * Nothing is revealed by fading: the page was never hidden, only
 * covered.
 */
function out(el, M) {
  document.documentElement.classList.remove("is-loading");

  const done = () => {
    el.remove();
    /* typing.js waits on this rather than on load, so a hero never types
       itself behind a panel nobody has seen move. */
    document.dispatchEvent(new CustomEvent("adeia:ready"));
  };

  if (!M || reduced.matches) {
    done();
    return;
  }

  const inner = el.querySelector("[data-loader-inner]");
  const rule = el.querySelector("[data-loader-rule]");
  const top = el.querySelector("[data-loader-top]");
  const bottom = el.querySelector("[data-loader-bottom]");

  /* The count leaves. */
  M.animate(
    inner,
    { opacity: [1, 0], transform: ["translateY(0px)", "translateY(-12px)"] },
    { duration: 0.28, ease: [0.4, 0, 0.2, 1] },
  );

  /* The seam flares, then goes with the halves. */
  M.animate(
    rule,
    { opacity: [1, 1, 0], transform: ["scaleY(1)", "scaleY(3)", "scaleY(1)"] },
    { duration: 0.5, delay: 0.16, ease: [0.4, 0, 0.2, 1] },
  );

  const part = { type: "spring", stiffness: 120, damping: 20, mass: 1 };

  M.animate(top, { transform: ["translateY(0%)", "translateY(-100%)"] }, {
    ...part,
    delay: 0.3,
  });

  /* A beat behind the top, so the gap opens rather than the screen
     splitting evenly in two. */
  return M.animate(bottom, { transform: ["translateY(0%)", "translateY(100%)"] }, {
    ...part,
    delay: 0.38,
  }).finished.then(done, done);
}
