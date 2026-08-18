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
  const swept = document.querySelectorAll(".sweep");
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
        el.style.setProperty("--mx", `${((event.clientX - rect.left) / rect.width) * 100}%`);
        el.style.setProperty("--my", `${((event.clientY - rect.top) / rect.height) * 100}%`);
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

function masthead() {
  const mast = document.querySelector(".mast");
  const hero = document.querySelector(".hero");
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
masthead();
