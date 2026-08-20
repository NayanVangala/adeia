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

/* Whatever happens, it is gone by this. */
const CEILING_MS = 4000;

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

  const ceiling = setTimeout(finish, CEILING_MS);

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
    const target = Math.min(drift * 0.96, real === 1 ? 1 : real + 0.24);

    shown += (target - shown) * 0.12;

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
 * The overlay lifts and the page is already behind it — nothing is
 * revealed by fading, because the page was never hidden, only covered.
 * The counter goes first and slightly faster than the panel, so the
 * two do not move as one slab.
 */
function out(el, M) {
  document.documentElement.classList.remove("is-loading");

  const done = () => {
    el.remove();
    /* typing.js waits on this rather than on load, so a hero never types
       itself behind a panel nobody has seen it move. */
    document.dispatchEvent(new CustomEvent("adeia:ready"));
  };

  if (!M || reduced.matches) {
    done();
    return;
  }

  const inner = el.querySelector("[data-loader-inner]");

  M.animate(
    inner,
    { opacity: [1, 0], transform: ["translateY(0px)", "translateY(-14px)"] },
    { duration: 0.32, ease: [0.4, 0, 0.2, 1] },
  );

  M.animate(
    el,
    { transform: ["translateY(0%)", "translateY(-100%)"] },
    {
      type: "spring",
      stiffness: 140,
      damping: 22,
      mass: 0.9,
      delay: 0.14,
    },
  ).finished.then(done, done);
}
