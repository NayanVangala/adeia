/* ---------------------------------------------------------------
   The particle body.

   A latitude-banded sphere, thickened into a shell and roughened with
   low-frequency radial noise so the silhouette is not a clean circle.
   Projected orthographically; depth drives both alpha and size, which
   is what reads as volume rather than a flat disc of dots.

   The body is also the policy. Distance from the centre is the amount
   being requested. Inside the inner ring it is within the $50.00
   per-action limit and the body opens and brightens. Between the rings
   it is over that limit, so the body tightens and holds. Outside the
   outer ring it is past the $1,000.00 hard ceiling and the body closes
   and dims. Both radii are drawn — the inner solid, the outer dashed —
   so the fence is visible rather than implied.

   Same numbers as scripts/seed.ts.

   Performance, in order of how much it matters:
     - alpha is quantised into a palette of rgba strings rebuilt once
       per frame. Building a string per point is what kills the budget.
     - points are counting-sorted into their palette bucket, so
       fillStyle is assigned once per bucket rather than once per point.
     - the loop stops entirely when the canvas leaves the viewport or
       the tab is hidden.
     - prefers-reduced-motion draws exactly one frame and binds no
       pointer listeners at all.
   --------------------------------------------------------------- */
(function () {
  "use strict";

  var canvas = document.getElementById("particles");
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var amountEl = document.getElementById("ro-amount");
  var verdictEl = document.getElementById("ro-verdict");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- palette, read from the stylesheet ----------
     The colours live in tokens.css. Reading them here keeps one source
     of truth; the fallbacks only matter if the sheet has not parsed. */
  var css = getComputedStyle(document.documentElement);

  function rgb(name, fallback) {
    var hex = css.getPropertyValue(name).trim().replace("#", "");
    if (hex.length !== 6) hex = fallback;
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }

  var MIST = rgb("--mist", "eddfee");
  var ORCHID = rgb("--orchid", "cd8dbd");

  /* The mass is white-to-pale; the stragglers are the accent. Two tones
     only — a third would double the palette for no visible gain. */
  var TONE_PALE = mix(MIST, [255, 255, 255], 0.55);
  var TONE_MARK = ORCHID;

  function paint(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }

  /* ---------- policy, mirrored from the seed policy ---------- */
  var PER_ACTION_CENTS = 5000; /* $50.00 per action */
  var HARD_MAX_CENTS = 100000; /* $1,000.00 hard ceiling */
  var CEILING_CENTS = 250000; /* top of the readout's range */

  /* Fractions of the field radius where each rule bites. */
  var R_LIMIT = 0.44;
  var R_HARD = 0.82;

  /* Distance -> cents, piecewise so all three bands are reachable and
     the boundaries land exactly on the two drawn rings. */
  function centsAt(t) {
    if (t <= R_LIMIT) return (t / R_LIMIT) * PER_ACTION_CENTS;
    if (t <= R_HARD) {
      return (
        PER_ACTION_CENTS +
        ((t - R_LIMIT) / (R_HARD - R_LIMIT)) *
          (HARD_MAX_CENTS - PER_ACTION_CENTS)
      );
    }
    return (
      HARD_MAX_CENTS +
      Math.min((t - R_HARD) / (1 - R_HARD), 1) *
        (CEILING_CENTS - HARD_MAX_CENTS)
    );
  }

  function verdictFor(cents) {
    if (cents > HARD_MAX_CENTS) return "denied";
    if (cents > PER_ACTION_CENTS) return "held";
    return "executed";
  }

  var LABEL = { executed: "Executed", held: "Held", denied: "Denied" };

  /* core   — radius of the mass
     spread — radius of the stragglers, so they pull in with it
     alpha  — overall brightness
     glow   — the seating bloom behind the mass */
  var TARGET = {
    executed: { core: 0.88, spread: 1.0, alpha: 1.0, glow: 1.0 },
    held: { core: 0.75, spread: 0.86, alpha: 0.86, glow: 0.62 },
    denied: { core: 0.62, spread: 0.72, alpha: 0.6, glow: 0.28 },
  };

  /* ---------- geometry ---------- */
  var CORE_N = 5600;
  var STRAY_N = 240;

  /* Low-frequency radial noise. Four out-of-phase sines summing to
     +/-0.18 give a body that is recognisably a sphere but never a
     clean circle in silhouette. Baked into the point at build time —
     it costs nothing per frame. */
  function lump(x, y, z) {
    return (
      1 +
      0.06 * Math.sin(2.3 * x + 0.7) +
      0.05 * Math.sin(1.9 * y - 1.4) +
      0.04 * Math.sin(2.7 * z + 2.2) +
      0.03 * Math.sin(1.6 * (x + y + z) + 0.3)
    );
  }

  /* Points on latitude bands rather than a Fibonacci spiral: the
     banding is what gives the body its woven, contour-drawn texture. */
  function banded(n, jitter) {
    var pts = [];
    var bands = Math.round(Math.sqrt(n * 0.95));
    for (var b = 0; b < bands; b++) {
      var v = (b + 0.5) / bands;
      var phi = Math.acos(1 - 2 * v);
      var yb = Math.cos(phi);
      var rad = Math.sin(phi);
      var count = Math.max(3, Math.round((n / bands) * rad * 1.5));
      for (var i = 0; i < count; i++) {
        var theta = (i / count) * Math.PI * 2 + b * 0.61;
        /* A shell with thickness, not a surface: without depth here the
           projection leaves a hollow centre and the body reads as a ring. */
        var w =
          (0.58 + 0.42 * Math.pow(Math.random(), 0.35)) *
          (1 + (Math.random() - 0.5) * jitter);
        var ux = Math.cos(theta) * rad;
        var uz = Math.sin(theta) * rad;
        var k = w * lump(ux, yb, uz);
        pts.push({
          x: ux * k,
          y: yb * k,
          z: uz * k,
          s: 0.45 + Math.random() * 0.5,
          /* A small minority of the mass carries the accent, weighted
             towards the outside so it reads as specks on the rim. */
          t: Math.random() < 0.035 + k * 0.02 ? 1 : 0,
        });
      }
    }
    return pts;
  }

  /* The stragglers keep the spiral — they should not echo the banding.
     Their radius is capped at STRAY_MAX because the whole field has to
     fit the corridor the type leaves it; see layout(). */
  var STRAY_MAX = 1.14;

  function stray(n) {
    var pts = [];
    var golden = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var y = 1 - (i / (n - 1)) * 2;
      var rad = Math.sqrt(Math.max(0, 1 - y * y));
      var theta = i * golden;
      var k = 0.98 + Math.random() * (STRAY_MAX - 0.98);
      pts.push({
        x: Math.cos(theta) * rad * k,
        y: y * k,
        z: Math.sin(theta) * rad * k,
        s: 0.7 + Math.random() * 0.7,
        /* Mostly accent, a few pale, so the outfield is not a solid
           block of colour. */
        t: Math.random() < 0.76 ? 1 : 0,
        p: Math.random() * Math.PI * 2,
      });
    }
    return pts;
  }

  var coreList = banded(CORE_N, 0.05);
  CORE_N = coreList.length;
  var strayList = stray(STRAY_N);

  /* Flat typed arrays: the per-frame loop touches these five and
     nothing else. */
  var bx = new Float32Array(CORE_N);
  var by = new Float32Array(CORE_N);
  var bz = new Float32Array(CORE_N);
  var bs = new Float32Array(CORE_N);
  var bt = new Uint8Array(CORE_N);
  for (var n = 0; n < CORE_N; n++) {
    bx[n] = coreList[n].x;
    by[n] = coreList[n].y;
    bz[n] = coreList[n].z;
    bs[n] = coreList[n].s;
    bt[n] = coreList[n].t;
  }
  coreList = null;

  /* ---------- the quantised palette ----------
     Two tones x STEPS alpha levels. Rebuilt once per frame; every point
     then indexes into it instead of composing its own rgba string. */
  var STEPS = 16;
  var BUCKETS = STEPS * 2;
  var pal = new Array(BUCKETS);

  function buildPalette(scale) {
    for (var t = 0; t < 2; t++) {
      var c = t === 0 ? TONE_PALE : TONE_MARK;
      for (var q = 0; q < STEPS; q++) {
        pal[t * STEPS + q] = paint(
          c,
          (((q + 1) / STEPS) * scale).toFixed(3),
        );
      }
    }
  }

  /* Scratch buffers for the counting sort. Allocated once. */
  var sxA = new Float32Array(CORE_N);
  var syA = new Float32Array(CORE_N);
  var ssA = new Float32Array(CORE_N);
  var sbA = new Uint8Array(CORE_N);
  var counts = new Int32Array(BUCKETS);
  var order = new Int32Array(CORE_N);

  /* ---------- sizing ----------
     The field is measured against the type, not against the canvas.
     Display type over a dot field is the one thing on this page that
     cannot be made to clear 3:1 by choosing a colour — a single bright
     dot behind a letterform is enough to fail it. So the body is sized
     and placed to sit in the hole the heading leaves, and never behind
     it. SAFE is the headroom for the outermost straggler plus the
     largest shove the cursor can give it. */
  var SAFE = 1.34;

  var W = 0;
  var H = 0;
  var R = 0;
  var fx = 0;
  var fy = 0;
  var pushR2 = 0;
  var invPushR2 = 0;
  var dpr = 1;

  var titleA = document.querySelector(".hero__title-block--start");
  var titleB = document.querySelector(".hero__title-block--end");
  var readoutEl = document.querySelector(".hero__readout");

  function localRect(el, cr) {
    if (!el) return null;
    var b = el.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    return {
      l: b.left - cr.left,
      r: b.right - cr.left,
      t: b.top - cr.top,
      b: b.bottom - cr.top,
    };
  }

  function layout(cr) {
    var A = localRect(titleA, cr);
    var B = localRect(titleB, cr);
    var RO = localRect(readoutEl, cr);

    var top = H * 0.07;
    var bottom = RO ? RO.t - 10 : H * 0.9;
    var x0;
    var x1;

    if (A && B && B.l - A.r > W * 0.2) {
      /* Split heading: the body lives in the gap between the blocks. */
      x0 = A.r + 10;
      x1 = B.l - 10;
    } else {
      /* Stacked heading: the body drops into the space below the type. */
      x0 = 8;
      x1 = W - 8;
      var tb = Math.max(A ? A.b : 0, B ? B.b : 0);
      if (tb + 12 > top) top = tb + 12;
    }

    if (x1 - x0 < 40 || bottom - top < 40) {
      /* Nothing measurable — fall back to the canvas centre. */
      fx = W / 2;
      fy = H / 2;
      R = Math.min(W, H) * 0.22;
      return;
    }

    fx = (x0 + x1) / 2;
    fy = (top + bottom) / 2;
    R = Math.max(44, Math.min((x1 - x0) / 2, (bottom - top) / 2) / SAFE);
  }

  function resize() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout(rect);
    var pr = R * 0.55;
    pushR2 = pr * pr;
    invPushR2 = 1 / pushR2;
  }

  /* ---------- state ---------- */
  var pointer = { x: 0, y: 0, live: false, lastMove: 0 };
  var current = { core: 0.88, spread: 1.0, alpha: 1.0, glow: 1.0 };
  var rot = 0.6;
  var frame = 0;
  var running = false;
  var rafId = 0;
  var autoT0 = -1;
  var TILT = 0.42;

  /* How hard the cursor shoves the field, and how long the field takes
     to settle once it stops. 700ms is --d-reveal. */
  var PUSH_POINTER = 0.55;
  var PUSH_AUTO = 0.3;
  var SETTLE_MS = 700;

  /* A slow sweep through all three bands, so the hero demonstrates
     itself before anyone touches the mouse. */
  function autoPoint(now) {
    var s = now * 0.00015;
    var k = 0.5 + 0.48 * Math.sin(s * 0.73);
    return { x: Math.cos(s) * R * k * 1.2, y: Math.sin(s * 1.31) * R * k * 1.2 };
  }

  function draw(now) {
    if (!R) resize();
    if (!R) return;

    ctx.clearRect(0, 0, W, H);
    var cx = fx;
    var cy = fy;

    /* --- where is the request, and how disturbed is the field --- */
    var px;
    var py;
    var wx;
    var wy;
    var amp;

    if (!reduced && pointer.live && now - pointer.lastMove < 3000) {
      px = pointer.x - cx;
      py = pointer.y - cy;
      wx = pointer.x;
      wy = pointer.y;
      autoT0 = -1;
      /* Displacement relaxes as (1 - e)^4, i.e. the dots travel back
         fast and decelerate into place: easeOutQuart. */
      var e = (now - pointer.lastMove) / SETTLE_MS;
      amp = e >= 1 ? 0 : PUSH_POINTER * Math.pow(1 - e, 4);
    } else {
      pointer.live = false;
      var auto = autoPoint(now);
      px = auto.x;
      py = auto.y;
      wx = cx + px;
      wy = cy + py;
      if (autoT0 < 0) autoT0 = now;
      /* Ramp in, so handing back from a real cursor is not a pop. */
      amp = reduced ? 0 : PUSH_AUTO * Math.min((now - autoT0) / 900, 1);
    }

    var dist = Math.sqrt(px * px + py * py);
    var t = dist / R;
    var cents = centsAt(t);
    var state = verdictFor(cents);
    var goal = TARGET[state];

    var k = reduced ? 1 : 0.06;
    current.core += (goal.core - current.core) * k;
    current.spread += (goal.spread - current.spread) * k;
    current.alpha += (goal.alpha - current.alpha) * k;
    current.glow += (goal.glow - current.glow) * k;

    if (!reduced) rot += 0.0011;
    frame++;
    var breath = reduced
      ? 0
      : Math.sin(frame * 0.019) * (state === "held" ? 0.014 : 0.005);

    /* --- a single soft bloom to seat the mass on the ground --- */
    var glowR = R * 1.35;
    var g = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, glowR);
    g.addColorStop(0, paint(MIST, (0.085 * current.glow).toFixed(3)));
    g.addColorStop(0.55, paint(MIST, (0.03 * current.glow).toFixed(3)));
    g.addColorStop(1, paint(MIST, 0));
    ctx.fillStyle = g;
    ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);

    var cs = Math.cos(rot);
    var sn = Math.sin(rot);
    var ct = Math.cos(TILT);
    var st = Math.sin(TILT);

    /* --- the mass --- */
    var bodyR = R * current.core * (1 + breath);
    buildPalette(current.alpha);
    counts.fill(0);

    var i;
    for (i = 0; i < CORE_N; i++) {
      var x0 = bx[i];
      var y0 = by[i];
      var z0 = bz[i];
      var xr = x0 * cs - z0 * sn;
      var zr = x0 * sn + z0 * cs;
      var yr = y0 * ct - zr * st;
      var d = (y0 * st + zr * ct + 1) * 0.5;
      if (d < 0) d = 0;
      else if (d > 1) d = 1;

      var X = cx + xr * bodyR;
      var Y = cy + yr * bodyR;

      /* Radial shove away from the cursor. The falloff is written in
         squared distance so the inner loop needs no sqrt: displacement
         is (offset) * (1 - d2/r2)^2, which is zero at the cursor, peaks
         partway out, and is zero again at the edge of the influence. */
      if (amp > 0) {
        var ux = X - wx;
        var uy = Y - wy;
        var u2 = ux * ux + uy * uy;
        if (u2 < pushR2) {
          var f = 1 - u2 * invPushR2;
          var gg = f * f * amp;
          X += ux * gg;
          Y += uy * gg;
        }
      }

      var q = ((0.06 + d * d * 0.92) * STEPS) | 0;
      if (q < 0) q = 0;
      else if (q >= STEPS) q = STEPS - 1;

      sxA[i] = X;
      syA[i] = Y;
      ssA[i] = (0.5 + d) * bs[i];
      var b = bt[i] * STEPS + q;
      sbA[i] = b;
      counts[b]++;
    }

    /* Counting sort into palette order. Two extra passes over the
       points buy back thousands of fillStyle assignments. */
    var acc = 0;
    var bkt;
    for (bkt = 0; bkt < BUCKETS; bkt++) {
      var c0 = counts[bkt];
      counts[bkt] = acc;
      acc += c0;
    }
    for (i = 0; i < CORE_N; i++) order[counts[sbA[i]]++] = i;

    var start = 0;
    for (bkt = 0; bkt < BUCKETS; bkt++) {
      var end = counts[bkt];
      if (end > start) {
        ctx.fillStyle = pal[bkt];
        for (var j = start; j < end; j++) {
          var p = order[j];
          ctx.fillRect(sxA[p], syA[p], ssA[p], ssA[p]);
        }
        start = end;
      }
    }

    /* --- the stragglers, drifting outside the mass ---
       Slower rotation than the body and a slow radial wobble, so they
       read as loose rather than welded to it. */
    var strayR = R * current.spread * (1 + breath * 0.5);
    var cs2 = Math.cos(rot * 0.72);
    var sn2 = Math.sin(rot * 0.72);
    for (i = 0; i < STRAY_N; i++) {
      var sp = strayList[i];
      var wob = reduced ? 1 : 1 + Math.sin(now * 0.00042 + sp.p) * 0.06;
      var sxr = sp.x * cs2 - sp.z * sn2;
      var szr = sp.x * sn2 + sp.z * cs2;
      var syr = sp.y * ct - szr * st;
      var sd = (sp.y * st + szr * ct + 1) * 0.5;
      if (sd < 0) sd = 0;
      else if (sd > 1) sd = 1;

      var SX = cx + sxr * strayR * wob;
      var SY = cy + syr * strayR * wob;

      if (amp > 0) {
        var vx = SX - wx;
        var vy = SY - wy;
        var v2 = vx * vx + vy * vy;
        if (v2 < pushR2) {
          var vf = 1 - v2 * invPushR2;
          var vg = vf * vf * amp * 1.1;
          SX += vx * vg;
          SY += vy * vg;
        }
      }

      var sq = ((0.18 + sd * 0.72) * STEPS) | 0;
      if (sq < 0) sq = 0;
      else if (sq >= STEPS) sq = STEPS - 1;
      ctx.fillStyle = pal[sp.t * STEPS + sq];
      ctx.fillRect(SX, SY, sp.s, sp.s);
    }

    /* --- the fence: two rules, drawn --- */
    ctx.lineWidth = 1;
    ctx.strokeStyle = paint(MIST, 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, R * R_LIMIT, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = paint(ORCHID, 0.42);
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, R * R_HARD, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    /* --- the request itself ---
       No leader line back to the centre. It read as a cursor tether
       rather than as part of the object, and it followed the pointer
       across the whole hero. The dot alone marks the request. */
    var mark = state === "executed" ? MIST : ORCHID;
    var markA = state === "denied" ? 0.45 : 0.95;
    ctx.fillStyle = paint(mark, markA);
    ctx.beginPath();
    ctx.arc(cx + px, cy + py, 3, 0, Math.PI * 2);
    ctx.fill();

    /* --- the readout ---
       Digits are throttled so they stay legible while sweeping. The
       static path draws a single frame, so it must always write:
       gating on frame % 3 alone leaves the readout at $0.00 forever
       under prefers-reduced-motion. */
    if (amountEl && (reduced || frame % 3 === 0)) {
      amountEl.textContent =
        "$" +
        (cents / 100).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
    }
    if (verdictEl && verdictEl.dataset.state !== state) {
      verdictEl.dataset.state = state;
      verdictEl.textContent = LABEL[state];
    }
  }

  function loop(now) {
    draw(now);
    if (running) rafId = window.requestAnimationFrame(loop);
  }

  function start() {
    if (running || reduced) return;
    running = true;
    rafId = window.requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (rafId) window.cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /* ---------- wiring ---------- */
  resize();

  window.addEventListener("resize", function () {
    resize();
    if (reduced) draw(0);
  });

  /* The field is measured against the rendered heading, so it has to be
     measured again once the real face has replaced the fallback. */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      resize();
      if (reduced) draw(0);
    });
  }

  if (reduced) {
    /* One frame, no listeners, no loop. */
    draw(0);
  } else {
    if (window.matchMedia("(pointer: fine)").matches) {
      window.addEventListener(
        "pointermove",
        function (e) {
          var rect = canvas.getBoundingClientRect();
          pointer.x = e.clientX - rect.left;
          pointer.y = e.clientY - rect.top;
          pointer.live = true;
          pointer.lastMove = window.performance.now();
        },
        { passive: true },
      );
    }

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) start();
        else stop();
      }).observe(canvas);
    } else {
      start();
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stop();
      else start();
    });
  }
})();
