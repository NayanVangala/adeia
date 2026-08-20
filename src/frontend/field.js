/**
 * Adeia — the field behind each page's opening.
 *
 * The fence at the foot of the landing page works because the picture is
 * the argument: you push it, it bends, it holds, and there is one gap.
 * A generic particle drift would have been prettier and meant nothing.
 *
 * So this is one engine and eight scenes, and each scene is the thing
 * its page is about rather than decoration attached to it. The engine
 * owns the canvas, the pointer, the visibility gating, the colours and
 * the reduced-motion path; a scene owns only what it draws.
 *
 * A page opts in with `<canvas class="field" data-field="proof">` in its
 * hero. Nothing else on the page changes.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const canHover = window.matchMedia("(hover: hover)");

/* Clamped, so a tab returning from the background does not hand a scene
   a delta measured in seconds. */
const MAX_STEP = 1 / 30;

/* ------------------------------------------------------------------ *
 * Colour, read from the stylesheet so no scene can drift from tokens.
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
    ground: at("--near", "#0d0d10"),
    cold: at("--cold", "#4fd1c5"),
    warm: at("--warm", "#e0679f"),
    paper: at("--paper", "#f4f4f6"),
    faint: at("--faint", "#6e6e7e"),
    hair: at("--hair-lit", "#33333d"),
  };
}

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
  const c = clamp(t, 0, 1) * (list.length - 1);
  const i = Math.min(Math.floor(c), list.length - 2);
  const f = c - i;
  const a = list[i];
  const b = list[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const ease = (t) => t * t * (3 - 2 * t);
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${a})`;

/* ------------------------------------------------------------------ *
 * The scenes.
 *
 * Each declares `build(s)` — called on load and on every resize, to lay
 * out whatever it needs from the current size — and `frame(s, step)`,
 * called once per animation frame with the seconds elapsed.
 *
 * `persist: true` means the engine does not clear between frames. Only
 * the audit scene wants that, and it wants it for a reason.
 * ------------------------------------------------------------------ */

const SCENES = {
  /* ---------------------------------------------------------------
     PROOF — 489 marks, one per test.

     Not "some dots". The count is the page's headline figure, so the
     field is that figure, and the ripple lets you feel how many that
     is by disturbing them.
     --------------------------------------------------------------- */
  proof: {
    build(s) {
      const TOTAL = 489;
      /* Lay them out as near a square as the canvas allows, so the
         block reads as a quantity rather than as a band. */
      const cols = Math.max(12, Math.round(Math.sqrt(TOTAL * (s.w / s.h))));
      const rows = Math.ceil(TOTAL / cols);
      const gapX = s.w / (cols + 1);
      const gapY = s.h / (rows + 1);

      s.dots = [];
      for (let i = 0; i < TOTAL; i += 1) {
        s.dots.push({
          x: ((i % cols) + 1) * gapX,
          y: (Math.floor(i / cols) + 1) * gapY,
          /* Where it sits in the entrance sweep. */
          seq: i / TOTAL,
          lift: 0,
        });
      }
    },

    frame(s) {
      const R = 150;
      for (const d of s.dots) {
        const grown = ease(clamp(s.progress * 1.5 - d.seq * 0.5, 0, 1));
        if (grown <= 0.01) continue;

        let target = 0;
        if (s.hot) {
          const near = clamp(1 - Math.hypot(s.px - d.x, s.py - d.y) / R, 0, 1);
          target = near * near;
        }
        d.lift += (target - d.lift) * 0.12;

        const r = (1.7 + d.lift * 2.8) * grown;
        const tone = mix(s.stops.sweep, 0.04 + d.lift * 0.85);
        s.ctx.fillStyle = rgba(tone, (0.55 + d.lift * 0.42) * grown);
        s.ctx.beginPath();
        s.ctx.arc(d.x, d.y - d.lift * 7, r, 0, Math.PI * 2);
        s.ctx.fill();
      }
    },
  },

  /* ---------------------------------------------------------------
     AUDIT — append-only.

     The canvas is never cleared. Every place the pointer has been stays
     on it, dimming to a floor it never drops below. You cannot rub any
     of it out, which is the one property the page is about.
     --------------------------------------------------------------- */
  audit: {
    persist: true,

    build(s) {
      s.ctx.clearRect(0, 0, s.w, s.h);
      s.trail = [];
      s.lastX = null;
      s.lastY = null;
    },

    frame(s, step) {
      /* Nothing fades. The first version painted a translucent ground
         over the canvas each frame to age the trail, which both
         contradicted the page — a log you can let go quiet is not
         append-only — and accumulated into a solid --near rectangle
         sitting over the hero. Marks are written light instead, so
         overlap builds density and the record only ever grows. */
      if (!s.hot || s.px < 0) return;

      /* One segment per frame, from where the pointer was to where it
         is, so a fast sweep writes a line and not a dotted trail. */
      if (s.lastX !== null) {
        const travelled = Math.hypot(s.px - s.lastX, s.py - s.lastY);
        if (travelled > 0.5) {
          /* Faster movement writes warmer and thicker — a burst of
             activity is louder in the record, as it is in a real one. */
          const heat = clamp(travelled / 40, 0, 1);
          s.ctx.strokeStyle = rgba(mix(s.stops.sweep, 0.1 + heat * 0.8), 0.34);
          s.ctx.lineWidth = 1 + heat * 2;
          s.ctx.lineCap = "round";
          s.ctx.beginPath();
          s.ctx.moveTo(s.lastX, s.lastY);
          s.ctx.lineTo(s.px, s.py);
          s.ctx.stroke();

          /* A tick at each entry, so the trail reads as a sequence of
             records rather than as a brush stroke. */
          if (travelled > 6) {
            s.ctx.fillStyle = rgba(s.stops.paper, 0.4);
            s.ctx.fillRect(s.px - 1, s.py - 1, 2, 2);
          }
        }
      }

      s.lastX = s.px;
      s.lastY = s.py;
    },

    /* With no pointer to record, draw a plausible trail so the canvas is
       not blank. */
    still(s) {
      s.ctx.strokeStyle = rgba(s.stops.hair, 0.85);
      s.ctx.lineWidth = 1;
      s.ctx.beginPath();
      for (let i = 0; i <= 60; i += 1) {
        const t = i / 60;
        const x = t * s.w;
        const y = s.h * (0.5 + 0.22 * Math.sin(t * 7) + 0.1 * Math.sin(t * 17));
        i ? s.ctx.lineTo(x, y) : s.ctx.moveTo(x, y);
      }
      s.ctx.stroke();
    },
  },

  /* ---------------------------------------------------------------
     POLICY — the three answers, as three bands.

     The cursor's height is an amount. Move up and the field crosses the
     per-action limit and then the hard ceiling, and the band you are in
     says which of the three words the engine would return. It is the
     page's calculator, played with a mouse instead of a keyboard.
     --------------------------------------------------------------- */
  policy: {
    build(s) {
      /* Two thresholds: the per-action limit low down, the hard ceiling
         high up. Above the ceiling is refusal; between them a person is
         asked; below the limit it simply runs. */
      s.limitY = s.h * 0.62;
      s.ceilY = s.h * 0.26;
      s.rules = [];
      for (let y = 0; y < s.h; y += 9) s.rules.push(y);
    },

    frame(s) {
      const at = s.hot ? s.py : s.h * 0.8;

      for (const y of s.rules) {
        const grown = ease(clamp(s.progress * 1.4 - (y / s.h) * 0.4, 0, 1));
        if (grown <= 0.01) continue;

        /* Which answer this height would get. */
        const band = y < s.ceilY ? 2 : y < s.limitY ? 1 : 0;
        const tone = band === 2 ? s.stops.faint : band === 1 ? s.stops.warm : s.stops.cold;

        /* The rule under the pointer, and its neighbours, come up. */
        const near = clamp(1 - Math.abs(at - y) / 90, 0, 1);
        const lit = near * near;

        /* Rules run from the left and stop short; the ones near the
           pointer run further, so the field has a readable edge that
           follows you. */
        const len = s.w * (0.18 + lit * 0.74);

        s.ctx.strokeStyle = rgba(tone, (0.22 + lit * 0.5) * grown);
        s.ctx.lineWidth = 1 + lit * 1.2;
        s.ctx.beginPath();
        s.ctx.moveTo(0, y + 0.5);
        s.ctx.lineTo(len, y + 0.5);
        s.ctx.stroke();
      }

      /* The two thresholds themselves, drawn over the field — these are
         the numbers, and they do not move for anybody. */
      for (const [y, tone] of [
        [s.ceilY, s.stops.faint],
        [s.limitY, s.stops.warm],
      ]) {
        s.ctx.strokeStyle = rgba(tone, 0.75 * ease(s.progress));
        s.ctx.lineWidth = 1;
        s.ctx.setLineDash([3, 5]);
        s.ctx.beginPath();
        s.ctx.moveTo(0, y + 0.5);
        s.ctx.lineTo(s.w, y + 0.5);
        s.ctx.stroke();
        s.ctx.setLineDash([]);
      }
    },
  },

  /* ---------------------------------------------------------------
     CAPABILITY — things that refuse.

     Every hover effect on the web opens up under the pointer. This one
     shuts. Cells close as you approach and reopen behind you, because
     the page is a list of what each part will not do.
     --------------------------------------------------------------- */
  capability: {
    build(s) {
      const STEP = 26;
      s.cells = [];
      for (let x = STEP / 2; x < s.w; x += STEP) {
        for (let y = STEP / 2; y < s.h; y += STEP) {
          s.cells.push({ x, y, shut: 0, seq: x / s.w });
        }
      }
      s.step = STEP;
    },

    frame(s) {
      const R = 170;
      const half = s.step * 0.34;

      for (const c of s.cells) {
        const grown = ease(clamp(s.progress * 1.4 - c.seq * 0.4, 0, 1));
        if (grown <= 0.01) continue;

        let target = 0;
        if (s.hot) {
          const near = clamp(1 - Math.hypot(s.px - c.x, s.py - c.y) / R, 0, 1);
          target = near * near * (3 - 2 * near);
        }
        c.shut += (target - c.shut) * 0.13;

        /* Open is an outlined square; shut is a small solid one. The
           closing is the animation. */
        const size = half * (1 - c.shut * 0.72);
        const tone = mix(s.stops.sweep, 0.06 + c.shut * 0.5);

        if (c.shut > 0.06) {
          s.ctx.fillStyle = rgba(tone, c.shut * 0.72 * grown);
          s.ctx.fillRect(c.x - size, c.y - size, size * 2, size * 2);
        } else {
          s.ctx.strokeStyle = rgba(tone, 0.4 * grown);
          s.ctx.lineWidth = 1;
          s.ctx.strokeRect(c.x - size, c.y - size, size * 2, size * 2);
        }
      }
    },
  },

  /* ---------------------------------------------------------------
     APPROACH — a decision has a cost.

     A beam on a pivot. Where you put the pointer is where the weight
     goes, and the beam tilts under it and settles. Every choice on that
     page was one that cost something; this is a picture of choosing.
     --------------------------------------------------------------- */
  approach: {
    build(s) {
      s.tilt = 0;
      s.tiltTo = 0;
      s.pivotX = s.w * 0.5;
      s.pivotY = s.h * 0.52;
      s.beam = Math.min(s.w * 0.36, 300);
    },

    frame(s) {
      /* Weight to one side of the pivot tips it that way, capped so the
         beam never stands on end. */
      s.tiltTo = s.hot ? clamp((s.px - s.pivotX) / (s.beam * 2.6), -0.24, 0.24) : 0;
      s.tilt += (s.tiltTo - s.tilt) * 0.07;

      const a = s.tilt * ease(s.progress);
      const dx = Math.cos(a) * s.beam;
      const dy = Math.sin(a) * s.beam;

      const shown = ease(s.progress);

      /* Graduations behind the beam. Without them the scene is two thin
         lines on a large dark field and reads as nothing at all. */
      for (let i = -8; i <= 8; i += 1) {
        if (!i) continue;
        const gx = s.pivotX + (i / 8) * s.beam * 1.15;
        const major = i % 4 === 0;
        const tone = i < 0 ? s.stops.cold : s.stops.warm;
        /* The graduations under the loaded end come up. */
        const near = clamp(1 - Math.abs((s.hot ? s.px : s.pivotX) - gx) / 220, 0, 1);
        s.ctx.strokeStyle = rgba(tone, (0.18 + near * 0.35) * shown);
        s.ctx.lineWidth = major ? 1.2 : 1;
        s.ctx.beginPath();
        s.ctx.moveTo(gx, s.pivotY - (major ? 26 : 14) - near * 12);
        s.ctx.lineTo(gx, s.pivotY - 4);
        s.ctx.stroke();
      }

      /* The pivot's upright. */
      s.ctx.strokeStyle = rgba(s.stops.hair, 0.5 * shown);
      s.ctx.lineWidth = 1;
      s.ctx.beginPath();
      s.ctx.moveTo(s.pivotX, s.pivotY);
      s.ctx.lineTo(s.pivotX, s.h);
      s.ctx.stroke();

      /* The beam, cold on the falling side and warm on the rising one —
         the same two marks the rest of the interface uses. */
      const grad = s.ctx.createLinearGradient(
        s.pivotX - dx,
        s.pivotY - dy,
        s.pivotX + dx,
        s.pivotY + dy,
      );
      grad.addColorStop(0, rgba(s.stops.cold, 0.55));
      grad.addColorStop(0.5, rgba(s.stops.hair, 0.7));
      grad.addColorStop(1, rgba(s.stops.warm, 0.55));

      s.ctx.strokeStyle = grad;
      s.ctx.lineWidth = 2.5;
      s.ctx.lineCap = "round";
      s.ctx.beginPath();
      s.ctx.moveTo(s.pivotX - dx, s.pivotY - dy);
      s.ctx.lineTo(s.pivotX + dx, s.pivotY + dy);
      s.ctx.stroke();

      /* The pans, hanging plumb whatever the beam does. */
      for (const side of [-1, 1]) {
        const hx = s.pivotX + dx * side;
        const hy = s.pivotY + dy * side;
        const drop = 34 + side * s.tilt * 90;
        const tone = side < 0 ? s.stops.cold : s.stops.warm;

        s.ctx.strokeStyle = rgba(tone, 0.6 * ease(s.progress));
        s.ctx.lineWidth = 1;
        s.ctx.beginPath();
        s.ctx.moveTo(hx, hy);
        s.ctx.lineTo(hx, hy + drop);
        s.ctx.stroke();

        s.ctx.beginPath();
        s.ctx.arc(hx, hy + drop, 9, 0, Math.PI);
        s.ctx.stroke();
      }
    },
  },

  /* ---------------------------------------------------------------
     QUICKSTART — eight steps, and you are somewhere along them.

     A track with eight stops. Your pointer's distance across the canvas
     is how far along you are, and the stops behind you are done. The
     page is a sequence, so the field is one too.
     --------------------------------------------------------------- */
  quickstart: {
    build(s) {
      s.stops8 = [];
      for (let i = 0; i < 8; i += 1) {
        s.stops8.push({
          x: ((i + 0.5) / 8) * s.w,
          y: s.h * (0.5 + 0.12 * Math.sin(i * 1.1)),
          on: 0,
        });
      }
      s.reach = 0;
    },

    frame(s) {
      const want = s.hot ? clamp(s.px / s.w, 0, 1) : 0.999;
      s.reach += (want - s.reach) * 0.08;
      const grown = ease(s.progress);

      /* The track, drawn through every stop. */
      s.ctx.strokeStyle = rgba(s.stops.hair, 0.85 * grown);
      s.ctx.lineWidth = 1;
      s.ctx.beginPath();
      s.stops8.forEach((p, i) => (i ? s.ctx.lineTo(p.x, p.y) : s.ctx.moveTo(p.x, p.y)));
      s.ctx.stroke();

      /* The part of it you have covered. */
      s.ctx.strokeStyle = rgba(s.stops.warm, 0.6 * grown);
      s.ctx.lineWidth = 1.5;
      s.ctx.beginPath();
      let drawn = false;
      for (const p of s.stops8) {
        if (p.x / s.w > s.reach) break;
        drawn ? s.ctx.lineTo(p.x, p.y) : s.ctx.moveTo(p.x, p.y);
        drawn = true;
      }
      if (drawn) s.ctx.stroke();

      for (const p of s.stops8) {
        const target = p.x / s.w <= s.reach ? 1 : 0;
        p.on += (target - p.on) * 0.12;

        const tone = mix(s.stops.sweep, 0.05 + p.on * 0.8);
        s.ctx.strokeStyle = rgba(tone, (0.45 + p.on * 0.5) * grown);
        s.ctx.fillStyle = rgba(tone, p.on * 0.25 * grown);
        s.ctx.lineWidth = 1 + p.on;
        s.ctx.beginPath();
        s.ctx.arc(p.x, p.y, 5 + p.on * 3, 0, Math.PI * 2);
        s.ctx.fill();
        s.ctx.stroke();
      }
    },
  },

  /* ---------------------------------------------------------------
     SDK — it asks, and something comes back.

     Pulses leave the left edge, reach the fence in the middle, and
     either return or stop there. Three methods, one direction of
     travel: the client only ever asks.
     --------------------------------------------------------------- */
  sdk: {
    build(s) {
      s.pulses = [];
      s.since = 0;
      s.midX = s.w * 0.62;
    },

    frame(s, step) {
      const grown = ease(s.progress);

      /* The fence the calls are asking through. */
      s.ctx.strokeStyle = rgba(s.stops.hair, 0.85 * grown);
      s.ctx.lineWidth = 1;
      s.ctx.setLineDash([2, 6]);
      s.ctx.beginPath();
      s.ctx.moveTo(s.midX, 0);
      s.ctx.lineTo(s.midX, s.h);
      s.ctx.stroke();
      s.ctx.setLineDash([]);

      s.since += step;
      if (s.since > 0.14 && s.progress > 0.2) {
        s.since = 0;
        /* Most calls come back. One in four stops at the fence and
           waits, which is roughly what a real policy does. */
        s.pulses.push({
          t: 0,
          y: 20 + Math.random() * (s.h - 40),
          held: Math.random() < 0.25,
          back: 0,
        });
      }

      /* The pointer drags the pulses toward it a little, so the field
         answers a mouse without being driven by one. */
      for (const p of s.pulses) {
        p.t += step * 0.55;
        const reach = Math.min(p.t, 1);
        let x = s.midX * ease(reach);

        if (reach >= 1) {
          if (p.held) {
            x = s.midX;
          } else {
            p.back += step * 0.7;
            x = s.midX * (1 - ease(Math.min(p.back, 1)));
          }
        }

        const pull = s.hot ? clamp(1 - Math.abs(s.py - p.y) / 160, 0, 1) : 0;
        const y = p.y + (s.py - p.y) * pull * 0.18;

        const tone = p.held ? s.stops.warm : s.stops.cold;
        s.ctx.fillStyle = rgba(tone, (p.held && reach >= 1 ? 0.85 : 0.6) * grown);
        s.ctx.beginPath();
        s.ctx.arc(x, y, p.held && reach >= 1 ? 3.5 : 2.5, 0, Math.PI * 2);
        s.ctx.fill();

        /* A tail, so the direction of travel is legible. */
        s.ctx.strokeStyle = rgba(tone, 0.35 * grown);
        s.ctx.lineWidth = 1;
        s.ctx.beginPath();
        s.ctx.moveTo(x, y);
        s.ctx.lineTo(x - 18 * (p.back > 0 ? -1 : 1), y);
        s.ctx.stroke();
      }

      /* Held ones stay a while — that is the point of them — but not
         forever, or the fence line silts up. */
      s.pulses = s.pulses.filter((p) => p.back < 1.2 && (p.held ? p.t < 9 : true));
    },

    /* Pulses only exist once time has passed, so a still frame of this
       scene is a dashed line and nothing else. This seeds the picture
       instead: calls at every stage of the same journey. */
    still(s) {
      s.pulses = [];
      for (let i = 0; i < 9; i += 1) {
        s.pulses.push({
          t: (i % 3) * 0.4 + 0.2,
          y: 26 + (i / 9) * (s.h - 52),
          held: i % 4 === 0,
          back: i % 3 === 2 ? 0.5 : 0,
        });
      }
      SCENES.sdk.frame(s, 0);
    },
  },

  /* ---------------------------------------------------------------
     CONTACT — a working thing, not a finished one.

     The fence again, and deliberately so: this is the same product. But
     stretches of it are missing, because the page's whole subject is
     what has been built and what has not.
     --------------------------------------------------------------- */
  contact: {
    build(s) {
      s.posts = [];
      for (let i = 0; i * 15 < s.w; i += 1) {
        /* Two stretches left out. Not random — the same two every load,
           so the gaps are a fact about the picture rather than noise. */
        const t = (i * 15) / s.w;
        const missing = (t > 0.34 && t < 0.44) || (t > 0.72 && t < 0.79);
        s.posts.push({
          x: i * 15 + 7,
          h: s.h * (0.42 + 0.3 * Math.sin(i * 0.13) + 0.12 * Math.sin(i * 0.4)),
          missing,
          seq: t,
          press: 0,
        });
      }
    },

    frame(s) {
      const grown = ease(s.progress);
      const R = 150;

      for (const p of s.posts) {
        const up = ease(clamp(s.progress * 1.5 - p.seq * 0.5, 0, 1));
        if (up <= 0.01) continue;

        let target = 0;
        if (s.hot) {
          const near = clamp(1 - Math.hypot(s.px - p.x, s.py - (s.h - p.h / 2)) / R, 0, 1);
          target = near * near;
        }
        p.press += (target - p.press) * 0.12;

        if (p.missing) {
          /* Where a post would be: a mark on the ground and nothing
             standing on it. */
          s.ctx.fillStyle = rgba(s.stops.faint, 0.55 * grown);
          s.ctx.fillRect(p.x - 1, s.h - 3, 2, 2);
          continue;
        }

        const tone = mix(s.stops.sweep, 0.06 + p.press * 0.7);
        s.ctx.strokeStyle = rgba(tone, (0.48 + p.press * 0.45) * up);
        s.ctx.lineWidth = 1.3 + p.press;
        s.ctx.lineCap = "round";
        s.ctx.beginPath();
        s.ctx.moveTo(p.x, s.h - 2);
        s.ctx.lineTo(p.x, s.h - 2 - p.h * up);
        s.ctx.stroke();
      }
    },
  },
};

/* ------------------------------------------------------------------ *
 * The engine.
 * ------------------------------------------------------------------ */

for (const canvas of document.querySelectorAll("[data-field]")) {
  const scene = SCENES[canvas.dataset.field];
  if (scene) start(canvas, scene);
}

function start(canvas, scene) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const host = canvas.closest("section") ?? canvas.parentElement;
  const stops = readStops();

  const s = {
    ctx,
    stops,
    w: 0,
    h: 0,
    px: -9999,
    py: -9999,
    hot: false,
    progress: 0,
    /* The ground a persistent scene paints over itself with, so the
       fading is the page's own field and not an invented grey. */
    ground: stops.ground,
  };

  let visible = false;
  let running = false;
  let last = 0;

  function layout() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    s.w = Math.max(1, Math.round(rect.width));
    s.h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(s.w * dpr);
    canvas.height = Math.round(s.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scene.build(s);
  }

  function draw(step) {
    const rect = host.getBoundingClientRect();
    s.progress = clamp((window.innerHeight - rect.top) / (rect.height * 0.8), 0, 1);
    if (!scene.persist) ctx.clearRect(0, 0, s.w, s.h);
    scene.frame(s, step);
  }

  function tick(now) {
    if (!visible) {
      running = false;
      return;
    }
    const step = last ? Math.min((now - last) / 1000, MAX_STEP) : 0;
    last = now;
    draw(step);
    requestAnimationFrame(tick);
  }

  function wake() {
    if (running || !visible) return;
    running = true;
    last = 0;
    requestAnimationFrame(tick);
  }

  window.addEventListener(
    "pointermove",
    (event) => {
      const rect = canvas.getBoundingClientRect();
      s.px = event.clientX - rect.left;
      s.py = event.clientY - rect.top;
      s.hot = true;
      wake();
    },
    { passive: true },
  );

  document.addEventListener("pointerleave", () => {
    s.hot = false;
    s.px = -9999;
    s.py = -9999;
  });

  let timer;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      layout();
      if (reduced.matches || !canHover.matches) still();
      else wake();
    }, 140);
  });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) wake();
      },
      { rootMargin: "140px" },
    ).observe(host);
  } else {
    visible = true;
  }

  /** The finished picture, once, for anyone who gets no animation. */
  function still() {
    s.progress = 1;
    s.hot = false;
    if (!scene.persist) ctx.clearRect(0, 0, s.w, s.h);
    (scene.still ?? scene.frame)(s, 0);
  }

  layout();

  if (reduced.matches || !canHover.matches) {
    still();
    return;
  }

  visible = true;
  wake();
}
