/**
 * Adeia — the fence at the foot of the page.
 *
 * A field of upright strokes across the full width. The pointer is the
 * agent: strokes bend away from it and warm toward the person end of
 * the gradient as it presses, and they spring back when it leaves. The
 * fence never breaks — that is the whole point of the picture, and the
 * reason the bend is capped rather than proportional.
 *
 * There is one gap in it. Things get through there, and only there.
 *
 * The strokes are not drawn at rest and then animated in. They grow out
 * of the baseline as the section enters the viewport, left to right, so
 * arriving at the bottom of the page builds the fence rather than
 * switching a backdrop on.
 *
 * Every colour is read from tokens.css at startup rather than written
 * here, so the canvas cannot drift from the rest of the interface.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const canHover = window.matchMedia("(hover: hover)");

/* ---------- geometry ---------- */

const SPACING = 15; /* px between strokes at rest */
const GAP_AT = 0.63; /* where the gap sits, as a fraction of the width */
const GAP_WIDTH = 6; /* strokes missing */
const RADIUS = 190; /* how far the pointer's influence reaches, px */
const MAX_BEND = 21; /* the cap. A fence that bends further is a fence that broke. */
const LIFT = 14; /* how much a pressed stroke rises */
const STAGGER = 0.55; /* how much of the build is spent sweeping left to right */

/* Frames with nothing moving before the loop parks itself. */
const IDLE_FRAMES = 40;

const canvas = document.querySelector("[data-fence]");
if (canvas) fence(canvas);

function fence(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const section = canvas.closest("section") ?? canvas.parentElement;
  const stops = readStops();

  let strokes = [];
  let width = 0;
  let height = 0;
  let baseY = 0;
  let gapX = 0;

  /* Pointer, in canvas coordinates. Parked far away so nothing is under
     pressure before the mouse has been anywhere near. */
  let px = -9999;
  let py = -9999;

  let progress = 0; /* 0..1, how far the section has entered the viewport */
  let visible = false;
  let running = false;
  let idle = 0;
  /* Reduced motion: the finished fence, drawn once, with no build and no
     loop. It has to bypass the scroll-driven progress entirely — reading
     it would draw nothing at all whenever the section starts below the
     fold, which is every first load. */
  let staticDraw = false;

  /* ---------- layout ---------- */

  function layout() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* The strokes stand on a line a little above the bottom edge, so the
       baseline itself is visible under them. */
    baseY = height - 2;

    const count = Math.max(8, Math.floor(width / SPACING));
    const gapStart = Math.round(count * GAP_AT);
    const gapEnd = gapStart + GAP_WIDTH;
    const tallest = height * 0.82;

    /* The middle of the gap, in canvas pixels, so it can be marked. */
    gapX = ((gapStart + gapEnd) / 2) * (width / count);

    strokes = [];
    for (let i = 0; i < count; i += 1) {
      if (i >= gapStart && i < gapEnd) continue;

      /* Three sines that do not share a period, so the skyline reads as
         irregular rather than as a wave. */
      const shape =
        0.69 + 0.16 * Math.sin(i * 0.11) + 0.1 * Math.sin(i * 0.037 + 1.7) + 0.05 * Math.sin(i * 0.29);

      strokes.push({
        x: (i + 0.5) * (width / count),
        /* Where it sits in the build order. */
        seq: i / count,
        h: tallest * shape,
        bend: 0,
        press: 0,
      });
    }
  }

  /* ---------- the frame ---------- */

  function draw() {
    ctx.clearRect(0, 0, width, height);

    /* How far the section has entered the viewport. Recomputed per frame
       rather than observed, because it has to track a scroll that is
       being eased by motion.js. */
    let next = 1;
    if (!staticDraw) {
      const rect = section.getBoundingClientRect();
      const entered = window.innerHeight - rect.top;
      next = clamp(entered / (rect.height * 0.72), 0, 1);
    }
    if (Math.abs(next - progress) > 0.0005) idle = 0;
    progress = next;

    /* The ground the fence stands on, drawn in before the strokes. */
    ctx.strokeStyle = `rgba(${stops.hair.join(",")},${0.55 * ease(progress)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseY + 0.5);
    ctx.lineTo(width, baseY + 0.5);
    ctx.stroke();

    ctx.lineCap = "round";

    for (const s of strokes) {
      /* Build. Each stroke waits its turn, so the fence sweeps up from
         the left rather than appearing all at once. */
      const grown = ease(clamp(progress * (1 + STAGGER) - s.seq * STAGGER, 0, 1));
      if (grown <= 0.001) continue;

      const h = s.h * grown;

      /* Pressure falls off from the pointer to the middle of the stroke,
         so a tall one is reachable further up than a short one. */
      let target = 0;
      if (canHover.matches && !reduced.matches) {
        const dx = px - s.x;
        const dy = py - (baseY - h * 0.5);
        const near = clamp(1 - Math.hypot(dx, dy) / RADIUS, 0, 1);
        target = near * near * (3 - 2 * near);

        /* Direction comes from the horizontal offset itself, not from its
           sign. Signing it means the two strokes either side of the
           pointer take opposite full-strength bends and the field opens
           as a hard V; scaling by the offset makes the bend fall back to
           nothing directly under the pointer and peak partway out, which
           is how a curtain actually moves. */
        const push = clamp(-dx / (RADIUS * 0.55), -1, 1);
        const bend = s.bend + (push * target * MAX_BEND - s.bend) * 0.14;

        /* Settled means stopped moving, not stopped being displaced. The
           first version tested the displacement itself, so a pointer
           resting inside the field held the strokes bent and redrew a
           motionless picture sixty times a second for as long as it sat
           there. */
        if (Math.abs(bend - s.bend) > 0.015) idle = 0;
        s.bend = bend;
      }

      const press = s.press + (target - s.press) * 0.14;
      if (Math.abs(press - s.press) > 0.0015) idle = 0;
      s.press = press;

      const top = baseY - h - s.press * LIFT;
      const bend = s.bend;

      /* Cold at rest, warm under a hand. The resting tint drifts a little
         across the width so a still fence is not one flat colour. */
      const tint = 0.05 + 0.12 * s.seq;
      const [r, g, b] = mix(stops.sweep, tint + s.press * (1 - tint));

      ctx.strokeStyle = `rgba(${r},${g},${b},${(0.26 + s.press * 0.68) * grown})`;
      ctx.lineWidth = 1.4 + s.press * 1.3;

      /* Glow only where it is being pressed. shadowBlur on every stroke
         is the difference between this costing nothing and costing the
         frame. */
      if (s.press > 0.12) {
        ctx.shadowColor = `rgba(${r},${g},${b},${s.press * 0.8})`;
        ctx.shadowBlur = 14 * s.press;
      }

      ctx.beginPath();
      ctx.moveTo(s.x, baseY);
      /* The control point sits low, so the stroke bows out of the ground
         rather than hinging at it. */
      ctx.quadraticCurveTo(s.x + bend * 0.3, baseY - h * 0.55, s.x + bend, top);
      ctx.stroke();

      ctx.shadowBlur = 0;
    }

    /* The gap, marked rather than merely empty — the one place an action
       gets through, and the same square the favicon sits on. */
    const shown = ease(clamp(progress * 1.4 - 0.4, 0, 1));
    if (shown > 0.01) {
      const [r, g, b] = mix(stops.sweep, 0.86);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.9 * shown})`;
      ctx.shadowColor = `rgba(${r},${g},${b},0.65)`;
      ctx.shadowBlur = 16;
      const size = 5;
      ctx.fillRect(gapX - size / 2, baseY - 26 - size / 2, size, size);
      ctx.shadowBlur = 0;
    }
  }

  /* ---------- the loop ----------
     Runs only while the section is on screen, and parks itself once
     nothing has moved for a while. Anything that could change the
     picture wakes it again. */

  function tick() {
    if (!visible) {
      running = false;
      return;
    }

    idle += 1;
    draw();

    if (idle > IDLE_FRAMES) {
      running = false;
      return;
    }

    requestAnimationFrame(tick);
  }

  function wake() {
    idle = 0;
    if (running || !visible) return;
    running = true;
    requestAnimationFrame(tick);
  }

  /* ---------- wiring ---------- */

  window.addEventListener(
    "pointermove",
    (event) => {
      const rect = canvas.getBoundingClientRect();
      px = event.clientX - rect.left;
      py = event.clientY - rect.top;
      wake();
    },
    { passive: true },
  );

  /* Leaving the window releases the fence rather than freezing it mid-bend. */
  document.addEventListener("pointerleave", () => {
    px = -9999;
    py = -9999;
    wake();
  });

  window.addEventListener("scroll", wake, { passive: true });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      layout();
      if (staticDraw) draw();
      else wake();
    }, 120);
  });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) wake();
      },
      { rootMargin: "120px" },
    ).observe(section);
  } else {
    visible = true;
  }

  layout();

  if (reduced.matches) {
    staticDraw = true;
    draw();
    return;
  }

  visible = true;
  wake();
}

/* ------------------------------------------------------------------ *
 * Colour, read from the stylesheet.
 * ------------------------------------------------------------------ */

function readStops() {
  const css = getComputedStyle(document.documentElement);
  const at = (name, fallback) => rgb(css.getPropertyValue(name).trim() || fallback);

  return {
    sweep: [
      at("--cold", "#4fd1c5"),
      at("--cool", "#5b9be8"),
      at("--mid", "#9b7bd4"),
      at("--warm", "#e0679f"),
      at("--hot", "#f2568c"),
    ],
    hair: at("--hair-lit", "#33333d"),
  };
}

/** `#4fd1c5` -> [79, 209, 197]. */
function rgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** A position from 0 to 1 along a list of colours. */
function mix(list, t) {
  const clamped = clamp(t, 0, 1) * (list.length - 1);
  const i = Math.min(Math.floor(clamped), list.length - 2);
  const f = clamped - i;
  const a = list[i];
  const b = list[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function clamp(n, min, max) {
  return n < min ? min : n > max ? max : n;
}

/** Smoothstep, so the build eases in and out rather than ramping. */
function ease(t) {
  return t * t * (3 - 2 * t);
}
