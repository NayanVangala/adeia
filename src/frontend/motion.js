/**
 * Adeia — the custom cursor and inertial scrolling.
 *
 * Both are opt-in at runtime. Neither is applied on a touch device or
 * for anyone who has asked for reduced motion, and the native cursor is
 * only hidden after this file has successfully run — so a throw, a
 * failed load, or a browser that chokes on any of it leaves the page
 * working exactly as it did before.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const canHover = window.matchMedia("(hover: hover)");
const enabled = canHover.matches && !reduced.matches;

/* ------------------------------------------------------------------ *
 * The cursor.
 *
 * A point that tracks exactly and a ring that lags. The lag is the
 * effect — a ring arriving a moment late is what gives the pointer
 * mass. The point never lags, because that is where the click lands and
 * an eased hit target is a broken one.
 * ------------------------------------------------------------------ */

function cursor() {
  if (!enabled) return;

  const point = document.createElement("div");
  point.className = "cursor";
  const ring = document.createElement("div");
  ring.className = "cursor-ring";
  /* The visible square lives in a child. The anchor carries the position
     and nothing else, so a state that rotates the square cannot rotate
     where it is standing — see the note in cursor.css. */
  const ringBox = document.createElement("div");
  ringBox.className = "cursor-ring__box";
  ring.append(ringBox);
  document.body.append(ring, point);

  let px = window.innerWidth / 2;
  let py = window.innerHeight / 2;
  let rx = px;
  let ry = py;
  let running = false;

  const move = (event) => {
    px = event.clientX;
    py = event.clientY;
    // The point is written immediately: it must never trail the pointer.
    point.style.transform = `translate(${px}px, ${py}px)`;
    // First real position: only now does the substitute know where to
    // stand, so only now is the native one hidden. Adding the class at
    // load instead paints both squares at the origin until the pointer
    // first moves, and takes the cursor away from anyone who never
    // moves one at all.
    document.documentElement.classList.add("has-cursor");
    if (!running) {
      running = true;
      requestAnimationFrame(step);
    }
  };

  function step() {
    rx += (px - rx) * 0.18;
    ry += (py - ry) * 0.18;
    ring.style.transform = `translate(${rx}px, ${ry}px)`;

    if (Math.abs(px - rx) > 0.1 || Math.abs(py - ry) > 0.1) {
      requestAnimationFrame(step);
    } else {
      running = false;
    }
  }

  window.addEventListener("pointermove", move, { passive: true });

  /* State. Read from what is under the pointer rather than bound to
     each element, so anything added later is covered without being
     registered. */
  const HOT = "a, button, summary, [role='tab'], [data-magnet], input, select, textarea";
  const COLD = ".card--machine, .bento__cell--machine, .eyebrow--machine, [data-machine]";
  const TEXT = "p, li, td, h1, h2, h3, blockquote";

  window.addEventListener(
    "pointerover",
    (event) => {
      const el = event.target;
      if (!(el instanceof Element)) return;

      const hot = el.closest(HOT);
      const cold = el.closest(COLD);
      const text = !hot && el.closest(TEXT);

      ring.classList.toggle("is-hot", Boolean(hot));
      ring.classList.toggle("is-cold", Boolean(cold));
      ring.classList.toggle("is-text", Boolean(text));
      point.classList.toggle("is-hidden", Boolean(text));
    },
    { passive: true },
  );

  window.addEventListener("pointerdown", () => ring.classList.add("is-down"), { passive: true });
  window.addEventListener("pointerup", () => ring.classList.remove("is-down"), { passive: true });

  // Leaving the window entirely: hide rather than freeze at the edge.
  document.addEventListener("pointerleave", () => {
    point.classList.add("is-out");
    ring.classList.add("is-out");
  });
  document.addEventListener("pointerenter", () => {
    point.classList.remove("is-out");
    ring.classList.remove("is-out");
  });
}

/* ------------------------------------------------------------------ *
 * Inertial scrolling.
 *
 * Eases the window toward a target position rather than jumping to it.
 *
 * Deliberately NOT the usual implementation. The common approach
 * translates a wrapper element, which is cheap and breaks every
 * `position: fixed` and `position: sticky` on the page — this page has
 * a fixed masthead and a sticky rail, both of which would come apart.
 * This drives `window.scrollTo` instead, so the browser's own scroll
 * position stays true and fixed, sticky, the scrollbar, anchor links,
 * find-in-page and assistive technology all keep working.
 *
 * Only wheel input is eased. Keyboard, scrollbar dragging, touch and
 * programmatic scrolling are left alone: those are people navigating
 * deliberately, and adding weight to them is an obstacle, not a feel.
 * ------------------------------------------------------------------ */

function inertialScroll() {
  if (!enabled) return;

  // Hand the browser's own smooth scrolling off before easing anything.
  // Left on, its animation and this one compound and the page overshoots.
  document.documentElement.classList.add("has-inertia");

  let target = window.scrollY;
  let current = window.scrollY;
  let running = false;
  let easing = false;

  const maxScroll = () =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  function step() {
    // 0.11 is slow enough to read as weight and fast enough not to feel
    // like the page is fighting you.
    current += (target - current) * 0.11;

    if (Math.abs(target - current) < 0.4) {
      current = target;
      running = false;
      easing = false;
      window.scrollTo(0, current);
      return;
    }

    window.scrollTo(0, current);
    requestAnimationFrame(step);
  }

  window.addEventListener(
    "wheel",
    (event) => {
      // Leave the browser alone for zoom and for horizontal intent.
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      event.preventDefault();

      // deltaMode 1 is lines, 2 is pages. Normalise to pixels.
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      target = Math.max(0, Math.min(maxScroll(), target + event.deltaY * scale));

      easing = true;
      if (!running) {
        running = true;
        requestAnimationFrame(step);
      }
    },
    { passive: false },
  );

  // Anything that moved the page by other means — a keypress, a dragged
  // scrollbar, an anchor jump — resets the target so the next wheel
  // event eases from where the page actually is rather than snapping
  // back to where this thought it was.
  window.addEventListener(
    "scroll",
    () => {
      if (!easing) {
        target = window.scrollY;
        current = window.scrollY;
      }
    },
    { passive: true },
  );

  window.addEventListener("resize", () => {
    target = Math.min(target, maxScroll());
  });

  // In-page links ease through the same loop rather than jumping. With
  // scroll-behavior off there would otherwise be no smoothing left on
  // them at all.
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!link) return;

    const id = link.getAttribute("href");
    if (!id || id === "#") return;

    const dest = document.querySelector(id);
    if (!dest) return;

    event.preventDefault();
    target = Math.max(0, Math.min(maxScroll(), window.scrollY + dest.getBoundingClientRect().top - 90));
    easing = true;
    if (!running) {
      running = true;
      requestAnimationFrame(step);
    }
    // Keep the URL and the focus ring honest for keyboard and screen
    // reader users, who are not the ones being eased.
    history.pushState(null, "", id);
    dest.setAttribute("tabindex", "-1");
    dest.focus({ preventScroll: true });
  });
}

cursor();
inertialScroll();
