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
 * It also walks rather than eases. Easing toward a moving target skips
 * most of the numbers — the first version went 0, 7, 23, 37 — so this
 * advances by exactly one a frame and never skips one. The cost is a
 * floor of about 1.7 seconds at 60Hz, because 101 numbers need 101
 * frames, and there is no way around that.
 *
 * It is also capped. If something never resolves the count sprints to
 * 100 and leaves anyway, rather than holding the site hostage to one
 * font file — but it still paints every number on the way, because a
 * count that vanishes at 43 is worse than one that takes another third
 * of a second.
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

/* Minimum time a number is on screen. Just under a 60Hz frame, so the
   walk is limited by the display rather than by this. */
const STEP_MS = 15;

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

  /* The count walks. It advances by exactly one, at most once a frame,
     and never skips a value or goes backwards — so every number from 0
     to 100 is painted, whatever the connection did.

     That has a floor: 101 numbers each needing their own frame is about
     1.7 seconds at 60Hz, and proportionally less on a faster display.
     There is no way to show all of them in less. */
  let shown = 0;
  let done = false;
  let started = 0;
  let lastStep = 0;

  /* The panel never leaves mid-count. Whatever ends it — genuine
     readiness or the ceiling — the remaining numbers are run out first,
     just faster. A count that vanishes at 43 is worse than one that
     takes another third of a second to finish. */
  let sprinting = false;

  const leave = () => {
    if (done) return;
    done = true;
    out(el, M);
  };

  const sprint = () => {
    sprinting = true;
  };

  const ceiling = setTimeout(sprint, Math.max(400, CEILING_MS - sinceNavigation()));

  function paint() {
    num.textContent = String(shown).padStart(3, "0");
    bar.style.transform = `scaleX(${(shown / 100).toFixed(4)})`;
  }

  function frame(now) {
    if (!started) started = now;
    const elapsed = now - started;

    /* Where the truth is. */
    const real = landed / total;

    /* The highest number it is allowed to have reached. Below full
       readiness it runs ahead on a decelerating curve — a counter that
       stalls reads as broken — but stays short of 100, which only
       genuine readiness unlocks. */
    const drift = 1 - Math.exp(-elapsed / 620);
    const cap =
      real === 1 || sprinting
        ? 100
        : Math.floor(Math.min(drift * 0.96, real + 0.24) * 100);

    /* One step, one frame. STEP_MS is a floor rather than a pace: a
       display refreshing faster than 60Hz simply finishes sooner, and
       one refreshing slower cannot paint two numbers in a frame anyway. */
    /* Sprinting still paints every number; it just gives each one a
       single frame instead of a comfortable one. */
    const step = sprinting ? 0 : STEP_MS;

    if (shown < cap && now - lastStep >= step) {
      shown += 1;
      lastStep = now;
      paint();
    }

    if (shown >= 100) {
      clearTimeout(ceiling);
      /* A beat on 100, so it reads as arriving rather than as a number
         that happened to stop. Shorter if it had to sprint, since that
         path is already the apology. */
      setTimeout(leave, sprinting ? 140 : 260);
      return;
    }

    requestAnimationFrame(frame);
  }

  paint();
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
