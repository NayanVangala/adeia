/**
 * Adeia — cursor and scroll choreography.
 *
 * Four effects, one animation frame. Everything the pointer drives is
 * written to CSS custom properties inside a single rAF loop rather than
 * on the move event itself, because a mousemove handler that touches
 * the DOM fires far more often than the screen refreshes and spends
 * the difference on forced layout.
 *
 * Anyone who has asked for reduced motion gets none of this. The page
 * is already complete without it — every effect here is addition.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ------------------------------------------------------------------ *
 * 1. The bloom follows the cursor.
 *
 * Eased rather than pinned: the wash trails the pointer, which reads as
 * weight. Pinning it exactly makes the page feel like a flashlight.
 * ------------------------------------------------------------------ */

function bloom() {
  const hero = document.querySelector("[data-bloom]");
  if (!hero || reduced.matches) return;

  // Percentages, matching the CSS defaults so the first frame does not jump.
  let targetX = 50;
  let targetY = 42;
  let x = targetX;
  let y = targetY;
  let running = false;

  const onMove = (event) => {
    const rect = hero.getBoundingClientRect();
    targetX = ((event.clientX - rect.left) / rect.width) * 100;
    targetY = ((event.clientY - rect.top) / rect.height) * 100;
    if (!running) {
      running = true;
      requestAnimationFrame(step);
    }
  };

  function step() {
    // Critically damped enough to settle without ringing.
    x += (targetX - x) * 0.075;
    y += (targetY - y) * 0.075;

    hero.style.setProperty("--bx", `${x.toFixed(2)}%`);
    hero.style.setProperty("--by", `${y.toFixed(2)}%`);

    // Stop once it has arrived, so an idle tab burns nothing.
    if (Math.abs(targetX - x) > 0.05 || Math.abs(targetY - y) > 0.05) {
      requestAnimationFrame(step);
    } else {
      running = false;
    }
  }

  hero.addEventListener("pointermove", onMove, { passive: true });

  // Drift home when the pointer leaves, rather than freezing mid-corner.
  hero.addEventListener(
    "pointerleave",
    () => {
      targetX = 50;
      targetY = 42;
      if (!running) {
        running = true;
        requestAnimationFrame(step);
      }
    },
    { passive: true },
  );
}

/* ------------------------------------------------------------------ *
 * 2. Cards light up under the cursor.
 *
 * The gradient itself lives in CSS; this only reports where the pointer
 * is, in the card's own coordinates.
 * ------------------------------------------------------------------ */

function cardSheen() {
  if (reduced.matches) return;

  for (const card of document.querySelectorAll(".card")) {
    card.addEventListener(
      "pointermove",
      (event) => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${((event.clientX - rect.left) / rect.width) * 100}%`);
        card.style.setProperty("--my", `${((event.clientY - rect.top) / rect.height) * 100}%`);
      },
      { passive: true },
    );
  }
}

/* ------------------------------------------------------------------ *
 * 3. Magnetic buttons.
 *
 * The button leans toward the cursor within a small radius. Capped at a
 * few pixels — enough to feel alive, not enough to make the target move
 * out from under someone trying to click it.
 * ------------------------------------------------------------------ */

const MAGNET_PULL = 0.28;
const MAGNET_MAX = 7;

function magnetic() {
  if (reduced.matches || !window.matchMedia("(hover: hover)").matches) return;

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

    el.addEventListener(
      "pointerleave",
      () => {
        el.style.transform = "";
      },
      { passive: true },
    );
  }
}

/* ------------------------------------------------------------------ *
 * 4. Reveal on scroll, and the masthead's hairline.
 *
 * The observer adds .is-in and stops watching. If IntersectionObserver
 * is missing, everything is revealed at once — the content is the point
 * and the animation is not.
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
        // Stagger siblings so a row of cards arrives in sequence.
        const delay = Number(entry.target.dataset.revealDelay ?? 0);
        setTimeout(() => entry.target.classList.add("is-in"), delay);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.1 },
  );

  for (const el of items) observer.observe(el);
}

function masthead() {
  const mast = document.querySelector(".mast");
  if (!mast) return;

  const sentinel = document.querySelector("[data-bloom]") ?? document.body;
  if (!("IntersectionObserver" in window)) return;

  new IntersectionObserver(
    ([entry]) => mast.classList.toggle("is-stuck", !entry.isIntersecting),
    { rootMargin: "-70px 0px 0px 0px" },
  ).observe(sentinel);
}

bloom();
cardSheen();
magnetic();
reveal();
masthead();
