/* ---------------------------------------------------------------
   The aperture.

   A particle iris whose radius is a policy. Distance from the centre
   is the amount being requested: inside the inner ring the request is
   within the per-action limit and the iris opens; between the rings it
   is over the limit, so the iris tightens and holds; outside the outer
   ring it is past the hard ceiling and the iris closes.

   Same numbers as scripts/seed.ts: $50 per action, $1,000 hard ceiling.
   --------------------------------------------------------------- */
(function () {
  "use strict";

  var canvas = document.getElementById("aperture");
  if (!canvas || !canvas.getContext) return;

  var ctx = canvas.getContext("2d");
  var amountEl = document.getElementById("ro-amount");
  var verdictEl = document.getElementById("ro-verdict");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- palette, read from the stylesheet ---------- */
  var css = getComputedStyle(document.documentElement);
  function rgb(name) {
    var hex = css.getPropertyValue(name).trim().replace("#", "");
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  var BLUE = rgb("--blue");
  var DEEP = rgb("--deep");
  var HAZE = rgb("--haze");
  var MID = rgb("--mid");

  function paint(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }
  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }

  /* ---------- policy, mirrored from the seed policy ---------- */
  var PER_ACTION_CENTS = 5000;
  var HARD_MAX_CENTS = 100000;
  var CEILING_CENTS = 250000;

  /* Fractions of the aperture radius where each rule bites. They are
     drawn, so the fence is visible rather than implied. */
  var R_LIMIT = 0.44;
  var R_HARD = 0.82;

  /* Distance -> cents, piecewise so all three bands are reachable. */
  function centsAt(t) {
    if (t <= R_LIMIT) return (t / R_LIMIT) * PER_ACTION_CENTS;
    if (t <= R_HARD) {
      return (
        PER_ACTION_CENTS +
        ((t - R_LIMIT) / (R_HARD - R_LIMIT)) * (HARD_MAX_CENTS - PER_ACTION_CENTS)
      );
    }
    return (
      HARD_MAX_CENTS +
      Math.min((t - R_HARD) / (1 - R_HARD), 1) * (CEILING_CENTS - HARD_MAX_CENTS)
    );
  }

  function verdictFor(cents) {
    if (cents > HARD_MAX_CENTS) return "denied";
    if (cents > PER_ACTION_CENTS) return "held";
    return "executed";
  }

  var LABEL = { executed: "Executed", held: "Held", denied: "Denied" };
  var TARGET = {
    executed: { core: 0.78, shell: 1.06, tone: BLUE, alpha: 1.0 },
    held: { core: 0.72, shell: 0.95, tone: DEEP, alpha: 0.94 },
    denied: { core: 0.66, shell: 0.86, tone: MID, alpha: 0.72 },
  };

  /* ---------- geometry ----------
     A Fibonacci sphere gives an even point distribution; orthographic
     projection with a depth-driven alpha is what reads as volume. */
  var CORE_N = 8000;
  var SHELL_N = 200;
  var LINK_N = 34;

  /* Building an "rgba(...)" string per point dominates the frame cost, so
     alpha is quantised into a palette rebuilt once per frame instead. */
  var STEPS = 18;
  var palette = new Array(STEPS);
  function buildPalette(tone, scale) {
    for (var q = 0; q < STEPS; q++) {
      palette[q] = paint(tone, (((q + 1) / STEPS) * scale).toFixed(3));
    }
  }
  function shade(a) {
    var q = (a * STEPS) | 0;
    return palette[q < 0 ? 0 : q > STEPS - 1 ? STEPS - 1 : q];
  }

  /* Points laid on latitude bands rather than a Fibonacci spiral: the
     banding is what gives the body its woven, contour-drawn texture. */
  function banded(n, jitter) {
    var pts = [];
    var bands = Math.round(Math.sqrt(n * 0.95));
    for (var b = 0; b < bands; b++) {
      var v = (b + 0.5) / bands;
      var phi = Math.acos(1 - 2 * v);
      var y = Math.cos(phi);
      var rad = Math.sin(phi);
      var count = Math.max(3, Math.round((n / bands) * rad * 1.5));
      for (var i = 0; i < count; i++) {
        var theta = (i / count) * Math.PI * 2 + b * 0.61;
        /* A shell with thickness, not a surface: without depth here the
           projection leaves a hollow centre and the body reads as a ring. */
        var w = (0.56 + 0.44 * Math.pow(Math.random(), 0.35)) * (1 + (Math.random() - 0.5) * jitter);
        pts.push({
          x: Math.cos(theta) * rad * w,
          y: y * w,
          z: Math.sin(theta) * rad * w,
          s: 0.45 + Math.random() * 0.5,
        });
      }
    }
    return pts;
  }

  /* The shell keeps the spiral — it should not echo the core's banding. */
  function spiral(n, jitter) {
    var pts = [];
    var golden = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < n; i++) {
      var y = 1 - (i / (n - 1)) * 2;
      var rad = Math.sqrt(Math.max(0, 1 - y * y));
      var theta = i * golden;
      var wob = 1 + (Math.random() - 0.5) * jitter;
      pts.push({
        x: Math.cos(theta) * rad * wob,
        y: y * wob,
        z: Math.sin(theta) * rad * wob,
        s: 0.6 + Math.random() * 0.6,
      });
    }
    return pts;
  }

  var core = banded(CORE_N, 0.05);
  var shell = spiral(SHELL_N, 0.18);
  CORE_N = core.length;

  /* Sparse chords across the shell — b-agent's wireframe, without the mesh. */
  var links = [];
  (function () {
    var tries = 0;
    while (links.length < LINK_N && tries < LINK_N * 60) {
      tries++;
      var a = (Math.random() * SHELL_N) | 0;
      var b = (Math.random() * SHELL_N) | 0;
      if (a === b) continue;
      var p = shell[a];
      var q = shell[b];
      var d = Math.sqrt(
        (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y) + (p.z - q.z) * (p.z - q.z),
      );
      if (d > 0.85 && d < 1.75) links.push([a, b]);
    }
  })();

  /* ---------- sizing ---------- */
  var W = 0;
  var H = 0;
  var R = 0;
  var dpr = 1;

  function resize() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = rect.width;
    H = rect.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = Math.min(W, H) * 0.36;
  }

  /* ---------- state ---------- */
  var pointer = { x: 0, y: 0, live: false, lastMove: 0 };
  var current = { core: 0.76, shell: 1.05, tone: BLUE.slice(), alpha: 1 };
  var rot = 0.6;
  var frame = 0;
  var running = false;
  var rafId = 0;
  var TILT = 0.42;

  function autoPoint(now) {
    /* A slow sweep that visits all three bands, so the hero
       demonstrates itself before anyone touches the mouse. */
    var s = now * 0.00015;
    var k = 0.5 + 0.48 * Math.sin(s * 0.73);
    return { x: Math.cos(s) * R * k * 1.2, y: Math.sin(s * 1.31) * R * k * 1.2 };
  }

  /* A bloom with a hairline edge — the soap-bubble rim b-agent uses to
     give the empty field some geometry. */
  function haze(cx, cy, r, ox, oy, a, rim) {
    var g = ctx.createRadialGradient(cx + ox, cy + oy, r * 0.1, cx + ox, cy + oy, r);
    g.addColorStop(0, "rgba(255,255,255," + a + ")");
    g.addColorStop(0.62, "rgba(255,255,255," + a * 0.45 + ")");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, r, 0, Math.PI * 2);
    ctx.fill();

    if (rim) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oy, r * 0.94, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function draw(now) {
    if (!R) resize();
    if (!R) return;

    ctx.clearRect(0, 0, W, H);
    var cx = W / 2;
    var cy = H / 2;

    /* where is the request */
    var px;
    var py;
    if (pointer.live && now - pointer.lastMove < 3000) {
      px = pointer.x - cx;
      py = pointer.y - cy;
    } else {
      pointer.live = false;
      var auto = autoPoint(now);
      px = auto.x;
      py = auto.y;
    }

    var dist = Math.sqrt(px * px + py * py);
    var t = dist / R;
    var cents = centsAt(t);
    var state = verdictFor(cents);
    var goal = TARGET[state];

    var k = reduced ? 1 : 0.05;
    current.core += (goal.core - current.core) * k;
    current.shell += (goal.shell - current.shell) * k;
    current.alpha += (goal.alpha - current.alpha) * k;
    current.tone = mix(current.tone, goal.tone, k);

    if (!reduced) rot += 0.0011;
    frame++;
    var breath = reduced ? 0 : Math.sin(frame * 0.019) * (state === "held" ? 0.014 : 0.005);

    /* --- the soft lens, three overlapping blooms --- */
    haze(cx, cy, R * 1.42, 0, 0, 0.52, false);
    haze(cx, cy, R * 1.12, -R * 0.42, R * 0.2, 0.3, true);
    haze(cx, cy, R * 0.86, R * 0.36, -R * 0.34, 0.24, true);

    var cs = Math.cos(rot);
    var sn = Math.sin(rot);
    var ct = Math.cos(TILT);
    var st = Math.sin(TILT);

    function project(p, radius) {
      var x = p.x * cs - p.z * sn;
      var z0 = p.x * sn + p.z * cs;
      var y = p.y * ct - z0 * st;
      var z = p.y * st + z0 * ct;
      return { x: cx + x * radius, y: cy + y * radius, d: (z + 1) / 2 };
    }

    /* --- the shell: chords first, then its own points --- */
    var shellR = R * current.shell * (1 + breath * 0.4);
    var proj = new Array(SHELL_N);
    for (var i = 0; i < SHELL_N; i++) proj[i] = project(shell[i], shellR);

    ctx.lineWidth = 1;
    for (i = 0; i < links.length; i++) {
      var a = proj[links[i][0]];
      var b = proj[links[i][1]];
      ctx.strokeStyle = paint(MID, 0.05 + ((a.d + b.d) / 2) * 0.16);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (i = 0; i < SHELL_N; i++) {
      var sp = proj[i];
      ctx.fillStyle = paint(MID, (0.1 + sp.d * 0.45) * current.alpha);
      ctx.fillRect(sp.x, sp.y, 1.1, 1.1);
    }

    /* --- the core: the dense body of the iris --- */
    var coreR = R * current.core * (1 + breath);
    buildPalette(current.tone, current.alpha);
    for (i = 0; i < CORE_N; i++) {
      var cp = project(core[i], coreR);
      var size = (0.55 + cp.d * 0.85) * core[i].s;
      ctx.fillStyle = shade(0.06 + Math.pow(cp.d, 1.5) * 0.9);
      ctx.fillRect(cp.x, cp.y, size, size);
    }

    /* --- the fence: two rules, drawn --- */
    ctx.lineWidth = 1;
    ctx.strokeStyle = paint(BLUE, 0.38);
    ctx.beginPath();
    ctx.arc(cx, cy, R * R_LIMIT, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = paint(MID, 0.4);
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, R * R_HARD, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    /* --- the request itself --- */
    var mark = state === "denied" ? HAZE : DEEP;
    ctx.strokeStyle = paint(mark, 0.3);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + px, cy + py);
    ctx.stroke();

    ctx.fillStyle = paint(mark, 0.95);
    ctx.beginPath();
    ctx.arc(cx + px, cy + py, 3, 0, Math.PI * 2);
    ctx.fill();

    /* --- the readout --- */
    /* Throttled to keep the digits legible while sweeping — but the static
       path draws a single frame, so it must always write. */
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
  }

  /* ---------- wiring ---------- */
  resize();
  window.addEventListener("resize", function () {
    resize();
    if (reduced) draw(0);
  });

  if (reduced) {
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
