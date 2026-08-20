/**
 * Adeia — cursor, scroll and interaction choreography.
 *
 * Six behaviours, one animation frame. Anything the pointer drives is
 * written to CSS custom properties inside a single rAF loop rather than
 * on the event itself: a pointermove handler that touches the DOM fires
 * far more often than the screen refreshes, and spends the difference
 * on forced layout.
 *
 * Reduced motion gets none of it. The page is complete without every
 * effect here.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const canHover = window.matchMedia("(hover: hover)");

/* ------------------------------------------------------------------ *
 * A single pointer loop.
 *
 * Everything that needs the cursor subscribes here, so the page has one
 * rAF rather than one per effect. Each subscriber gets eased, normalised
 * coordinates: -1..1 from centre, and 0..100 as a percentage.
 * ------------------------------------------------------------------ */

const subscribers = [];
let targetNx = 0;
let targetNy = 0;
let nx = 0;
let ny = 0;
let looping = false;

function onPointer(event) {
  targetNx = (event.clientX / window.innerWidth) * 2 - 1;
  targetNy = (event.clientY / window.innerHeight) * 2 - 1;
  if (!looping) {
    looping = true;
    requestAnimationFrame(tick);
  }
}

function tick() {
  nx += (targetNx - nx) * 0.08;
  ny += (targetNy - ny) * 0.08;

  for (const fn of subscribers) fn(nx, ny);

  // Stop once it has arrived, so an idle tab costs nothing.
  if (Math.abs(targetNx - nx) > 0.001 || Math.abs(targetNy - ny) > 0.001) {
    requestAnimationFrame(tick);
  } else {
    looping = false;
  }
}

function onCursor(fn) {
  subscribers.push(fn);
}

if (!reduced.matches && canHover.matches) {
  window.addEventListener("pointermove", onPointer, { passive: true });
}

/* ------------------------------------------------------------------ *
 * 1. The gradient sweep tracks the cursor.
 *
 * The headline's gradient is wider than the text, so moving its
 * background-position slides different stops across the glyphs. The
 * word under your cursor is a different colour than it was a moment
 * ago, which is the effect the reference does not have.
 * ------------------------------------------------------------------ */

function gradientSweep() {
  const swept = document.querySelectorAll(".entry__num");
  if (!swept.length) return;

  onCursor((x) => {
    // -1..1 mapped into a band that never runs the gradient off the end.
    const pos = 46 + x * 30;
    for (const el of swept) el.style.setProperty("--sweep-x", `${pos.toFixed(1)}%`);
  });
}

/* ------------------------------------------------------------------ *
 * 2. The floating frames drift at different depths.
 *
 * Each frame declares its own --depth, so they separate as the pointer
 * moves and the backdrop reads as space rather than wallpaper.
 * ------------------------------------------------------------------ */

function frameParallax() {
  const hero = document.querySelector(".hero");
  if (!hero) return;

  onCursor((x, y) => {
    hero.style.setProperty("--px", x.toFixed(3));
    hero.style.setProperty("--py", y.toFixed(3));
  });
}

/* ------------------------------------------------------------------ *
 * 3. Cards and bento cells light from wherever the pointer is.
 *
 * Local coordinates, so this cannot go through the shared loop.
 * ------------------------------------------------------------------ */

function localSheen() {
  if (reduced.matches) return;

  for (const el of document.querySelectorAll(".card, .bento__cell")) {
    el.addEventListener(
      "pointermove",
      (event) => {
        const rect = el.getBoundingClientRect();
        const fx = (event.clientX - rect.left) / rect.width;
        const fy = (event.clientY - rect.top) / rect.height;

        /* 0..100% for the wash, which is a position on the card. */
        el.style.setProperty("--mx", `${fx * 100}%`);
        el.style.setProperty("--my", `${fy * 100}%`);
        /* -1..1 from the middle for the lean, which is a direction. */
        el.style.setProperty("--tx", (fx * 2 - 1).toFixed(3));
        el.style.setProperty("--ty", (fy * 2 - 1).toFixed(3));
      },
      { passive: true },
    );

    /* Back to flat on the way out, or the card keeps whatever angle the
       pointer left it at. */
    el.addEventListener(
      "pointerleave",
      () => {
        el.style.setProperty("--tx", "0");
        el.style.setProperty("--ty", "0");
      },
      { passive: true },
    );
  }
}

/* ------------------------------------------------------------------ *
 * 4. Magnetic buttons.
 *
 * Capped at a few pixels: enough to feel alive, not enough to move the
 * target out from under someone trying to click it.
 * ------------------------------------------------------------------ */

const MAGNET_PULL = 0.3;
const MAGNET_MAX = 8;

function magnetic() {
  if (reduced.matches || !canHover.matches) return;

  for (const el of document.querySelectorAll("[data-magnet]")) {
    el.addEventListener(
      "pointermove",
      (event) => {
        const rect = el.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        const x = Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, dx * MAGNET_PULL));
        const y = Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, dy * MAGNET_PULL));
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      },
      { passive: true },
    );

    el.addEventListener("pointerleave", () => (el.style.transform = ""), { passive: true });
  }
}

/* ------------------------------------------------------------------ *
 * 5. The sticky rail.
 *
 * Buttons rather than links, because nothing navigates — this swaps a
 * panel. Full keyboard support: arrows move, and selection follows
 * focus the way a tablist should.
 * ------------------------------------------------------------------ */

function rail() {
  for (const group of document.querySelectorAll("[data-rail]")) {
    const tabs = [...group.querySelectorAll("[role='tab']")];
    const panels = [...group.querySelectorAll("[role='tabpanel']")];
    if (!tabs.length) continue;

    const select = (index) => {
      tabs.forEach((tab, i) => {
        const on = i === index;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        panels[i]?.toggleAttribute("hidden", !on);
      });
    };

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(i));
      tab.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = (i + step + tabs.length) % tabs.length;
        tabs[next].focus();
        select(next);
      });
    });

    select(0);
  }
}

/* ------------------------------------------------------------------ *
 * 6. Reveal on scroll, and the masthead hairline.
 * ------------------------------------------------------------------ */

function reveal() {
  const items = document.querySelectorAll("[data-reveal]");

  if (!("IntersectionObserver" in window) || reduced.matches) {
    for (const el of items) el.classList.add("is-in");
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const delay = Number(entry.target.dataset.revealDelay ?? 0);
        setTimeout(() => entry.target.classList.add("is-in"), delay);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
  );

  for (const el of items) observer.observe(el);
}

/* ------------------------------------------------------------------ *
 * 7. The in-page anchor bar marks where you are.
 *
 * Document pages carry a sticky bar of section links. Without this it
 * is a list; with it, it is a position. Observed rather than driven off
 * scroll position, so it costs nothing while the page is still.
 * ------------------------------------------------------------------ */

function anchorSpy() {
  const bar = document.querySelector(".anchors");
  if (!bar || !("IntersectionObserver" in window)) return;

  const links = new Map();
  for (const a of bar.querySelectorAll("a[href^='#']")) {
    const target = document.getElementById(a.getAttribute("href").slice(1));
    if (target) links.set(target, a);
  }
  if (!links.size) return;

  // Whichever observed section is highest on screen wins. Tracking the
  // set rather than the last event keeps it right when a short section
  // scrolls past entirely between two frames.
  const visible = new Set();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }

      const top = [...visible].sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )[0];

      for (const [section, link] of links) {
        link.classList.toggle("is-here", section === top);
      }
    },
    // The band excludes the masthead and the bar itself, so a section
    // counts as current only once it is actually being read.
    { rootMargin: "-120px 0px -55% 0px", threshold: 0 },
  );

  for (const section of links.keys()) observer.observe(section);
}

function masthead() {
  const mast = document.querySelector(".mast");
  // Document pages open with .phero rather than the full-height .hero.
  const hero = document.querySelector(".hero, .phero");
  if (!mast || !hero || !("IntersectionObserver" in window)) return;

  new IntersectionObserver(
    ([entry]) => mast.classList.toggle("is-stuck", !entry.isIntersecting),
    { rootMargin: "-70px 0px 0px 0px" },
  ).observe(hero);
}

gradientSweep();
frameParallax();
localSheen();
magnetic();
rail();
reveal();
anchorSpy();
masthead();
