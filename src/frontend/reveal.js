/**
 * Adeia — entrances, on Motion.
 *
 * This replaces a CSS reveal that did one thing: fade up 24px on a fixed
 * curve, with every delay in a stagger typed into the markup by hand as
 * `data-reveal-delay="90"`. That worked and it was rigid — the delays
 * were guesses, they had to be maintained as sections changed, and every
 * element on the site arrived exactly the same way.
 *
 * Motion gives three things the old one could not:
 *
 *   springs      an entrance with weight rather than a bezier
 *   stagger      computed from the group, so no delay is ever typed
 *   inView       one observer per group, with proper margins
 *
 * The rule the old system had is kept, because it matters more than any
 * of the above: nothing here creates content. Every element is in the
 * document, readable, before this file runs. If it never loads, or the
 * reader asked for no motion, the page is simply finished.
 *
 * Loaded after vendor/motion.js, which is a classic script and therefore
 * evaluated before any module.
 */

const M = window.Motion;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

/* Nothing to animate with, or nothing wanted: leave the page alone. It
   is already correct — [data-reveal] only hides things once this file
   has confirmed it can put them back. */
if (M && !reduced.matches) {
  document.documentElement.classList.add("has-motion");
  entrances();
  accordions();
}

/* ------------------------------------------------------------------ *
 * Entrances.
 *
 * Elements are grouped by the section they live in, so a stagger is a
 * property of the group rather than of each element. Sections arrive
 * independently as you reach them.
 * ------------------------------------------------------------------ */

function entrances() {
  const groups = new Map();

  for (const el of document.querySelectorAll("[data-reveal]")) {
    const host = el.closest("section, footer, .rail__panel") ?? document.body;
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(el);
  }

  for (const [host, items] of groups) {
    /* Ordered by where they actually sit, not by document order. A
       two-column section reads left to right, and its markup usually
       does not. */
    items.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });

    M.inView(
      host,
      () => {
        M.animate(
          items,
          { opacity: [0, 1], transform: ["translateY(18px)", "translateY(0px)"] },
          {
            /* A spring rather than a curve: the difference between an
               element being placed and an element arriving. */
            type: "spring",
            stiffness: 180,
            damping: 24,
            mass: 0.9,
            /* Computed, not typed. The cap keeps a long section from
               taking a second and a half to finish landing. */
            delay: M.stagger(0.055, { startDelay: 0.02 }),
          },
        );

        /* One-shot: an element that has arrived stays arrived. */
        return false;
      },
      { margin: "0px 0px -12% 0px", amount: 0.15 },
    );
  }
}

/* ------------------------------------------------------------------ *
 * The FAQ.
 *
 * <details> snaps. Animating it needs the element open for the whole
 * closing animation, so the close is intercepted and the attribute is
 * removed only once the panel has finished collapsing.
 * ------------------------------------------------------------------ */

function accordions() {
  for (const item of document.querySelectorAll(".faq__item")) {
    const summary = item.querySelector(".faq__q");
    const panel = item.querySelector(".faq__a");
    if (!summary || !panel) continue;

    let busy = false;

    summary.addEventListener("click", (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;

      const opening = !item.open;
      /* Opening has to happen first so the panel has a height to
         measure; closing has to be deferred until the animation ends,
         or the content vanishes before it can shrink. */
      if (opening) item.open = true;

      const full = panel.scrollHeight;

      M.animate(
        panel,
        {
          height: opening ? [0, `${full}px`] : [`${full}px`, 0],
          opacity: opening ? [0, 1] : [1, 0],
        },
        { type: "spring", stiffness: 260, damping: 30, mass: 0.7 },
      ).finished.then(() => {
        panel.style.height = "";
        panel.style.opacity = "";
        if (!opening) item.open = false;
        busy = false;
      });
    });
  }
}
