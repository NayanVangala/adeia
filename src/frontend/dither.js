/* ---------------------------------------------------------------
   Adeia — the dot bowl

   Draws a dithered field of square dots into every [data-dither]
   canvas. The field is a bowl: a U-shaped rim with a hard-ish top
   edge, solid through the middle, dissolving at the sides and into
   the bottom edge rather than stopping at it. The closing CTA text
   sits inside it.

   Shape
     rim(u)   a parabola, lowest at the centre and rising at the
              sides, so the field reads as a vessel rather than a
              gradient. Density is 0 above it and ramps to 1 over a
              narrow band below it.
     sides    dissolve from |u| = 0.70 outward.
     bottom   dissolves over the last 12% of the height.

   Cost
     Colours are quantised to 2 x STEPS rgba strings built once. Each
     frame buckets cells by colour with a counting sort into reused
     typed arrays, then issues one fillStyle assignment per bucket
     instead of one per dot. No allocation in the frame loop.

   Runs as a classic script or a module; no dependencies.
   --------------------------------------------------------------- */

(function () {
  "use strict";

  var CELL = 9; /* grid pitch, CSS px */
  var DOT = 4; /* square dot size, CSS px */
  var INSET = 2; /* keeps dots on whole pixels at dpr 1 */
  var STEPS = 12; /* quantised alpha levels per colour */
  var A_MIN = 0.1;
  var A_MAX = 0.92;
  var MAX_DPR = 2;
  var POINTER_R = 150; /* CSS px of pointer influence */
  var BREATH_MS = 7200; /* one full breath */
  var ORCHID_SHARE = 0.11; /* fraction of dots tinted with the accent */

  /* Binary reveal. Cells close enough to the pointer render as a 0 or a 1
     instead of a square, so the field reads as data where a hand is on it.
     Kept well inside POINTER_R and hard-capped: fillText costs roughly an
     order of magnitude more than fillRect, and the whole point of the
     bucketed draw below is not paying that cost across the field. */
  var GLYPH_R = 92; /* CSS px — where glyphs appear at all */
  var GLYPH_MIN = 0.18; /* pointer boost a cell needs to become a glyph */
  var GLYPH_MAX = 260; /* per-frame ceiling on glyphs drawn */
  var GLYPH_SIZE = 11; /* CSS px */
  /* Digits get their own alpha ramp. Borrowing the dot palette put the faint
     end near invisible against the green, which read as nothing happening. */
  var GLYPH_A_MIN = 0.32;
  var GLYPH_A_MAX = 1;

  /* 4x4 ordered dither. Normalised to 0..1. */
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (var b = 0; b < 16; b++) BAYER[b] = BAYER[b] / 16;

  var instances = [];

  /* ---------- small helpers ---------- */

  /** Horizontal distance from a column centre to the pointer. */
  function dx0Abs(xpx, px) {
    var d = xpx - px;
    return d < 0 ? -d : d;
  }

  function smoothstep(e0, e1, x) {
    if (e1 === e0) return x < e0 ? 0 : 1;
    var t = (x - e0) / (e1 - e0);
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  /* Deterministic per-cell noise. Same cell, same value, every frame. */
  function hash(i) {
    var x = (i * 374761393 + 668265263) | 0;
    x = (x ^ (x >>> 13)) * 1274126177;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  }

  function readRgb(styles, name, fallback) {
    var raw = (styles.getPropertyValue(name) || "").trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
    if (m) {
      var hex = m[1];
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
    var n = raw.match(/\d+(\.\d+)?/g);
    if (n && n.length >= 3) return [+n[0], +n[1], +n[2]];
    return fallback;
  }

  /* ---------- one canvas ---------- */

  function Field(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.host = canvas.closest("section") || canvas.parentElement || canvas;
    this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    this.w = 0;
    this.h = 0;
    this.cols = 0;
    this.rows = 0;
    this.cells = 0;

    this.noise = null;
    this.tint = null;
    this.bucketOf = null;
    this.order = null;
    this.counts = new Int32Array(STEPS * 2);
    this.offsets = new Int32Array(STEPS * 2);

    this.palette = [];
    this.pointerX = 0;
    this.pointerY = 0;
    this.pointerPower = 0;
    this.pointerTarget = 0;

    this.running = false;
    this.visible = false;
    this.raf = 0;
    this.resizeRaf = 0;
    this.start0 = 0;

    this.stats = { frames: 0, last: 0, avg: 0, max: 0 };

    this.tick = this.tick.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerLeave = this.onPointerLeave.bind(this);
    this.onVisibility = this.onVisibility.bind(this);
    this.queueResize = this.queueResize.bind(this);

    this.buildPalette();
    this.measure();

    if (this.reduced.matches) {
      /* One static frame. No loop, no pointer listeners. */
      this.draw(0);
      this.observeResize();
      return;
    }

    this.bindPointer();
    this.observeResize();
    this.observeVisibility();
    document.addEventListener("visibilitychange", this.onVisibility);

    var self = this;
    var onPrefChange = function (e) {
      if (e.matches) {
        self.stop();
        self.unbindPointer();
        self.pointerPower = 0;
        self.draw(0);
      }
    };
    if (this.reduced.addEventListener) this.reduced.addEventListener("change", onPrefChange);
  }

  /* Two ramps of pre-built rgba strings: pale first, accent second. */
  Field.prototype.buildPalette = function () {
    var styles = getComputedStyle(this.canvas);
    var pale = readRgb(styles, "--mist", [237, 223, 238]);
    var accent = readRgb(styles, "--orchid", [205, 141, 189]);
    var out = [];
    for (var k = 0; k < STEPS; k++) {
      var a = A_MIN + ((A_MAX - A_MIN) * k) / (STEPS - 1);
      out.push("rgba(" + pale[0] + "," + pale[1] + "," + pale[2] + "," + a.toFixed(3) + ")");
    }
    for (var j = 0; j < STEPS; j++) {
      var a2 = A_MIN + ((A_MAX - A_MIN) * j) / (STEPS - 1);
      out.push("rgba(" + accent[0] + "," + accent[1] + "," + accent[2] + "," + a2.toFixed(3) + ")");
    }
    this.palette = out;

    /* Same two colours, brighter ramp, built once. */
    var glyphs = [];
    for (var m = 0; m < STEPS; m++) {
      var ga = GLYPH_A_MIN + ((GLYPH_A_MAX - GLYPH_A_MIN) * m) / (STEPS - 1);
      glyphs.push("rgba(" + pale[0] + "," + pale[1] + "," + pale[2] + "," + ga.toFixed(3) + ")");
    }
    for (var q = 0; q < STEPS; q++) {
      var ga2 = GLYPH_A_MIN + ((GLYPH_A_MAX - GLYPH_A_MIN) * q) / (STEPS - 1);
      glyphs.push(
        "rgba(" + accent[0] + "," + accent[1] + "," + accent[2] + "," + ga2.toFixed(3) + ")",
      );
    }
    this.glyphPalette = glyphs;
  };

  Field.prototype.measure = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cols = Math.ceil(w / CELL);
    this.rows = Math.ceil(h / CELL);
    var cells = this.cols * this.rows;

    if (cells !== this.cells) {
      this.cells = cells;
      this.noise = new Float32Array(cells);
      this.tint = new Uint8Array(cells);
      this.bucketOf = new Int8Array(cells);
      this.order = new Int32Array(cells);
      /* Allocated once, reused every frame. `glyphAt` packs x and y the same
         way `order` does; `glyphAlpha` carries the strength for each. */
      this.glyphAt = new Int32Array(GLYPH_MAX);
      this.glyphAlpha = new Float32Array(GLYPH_MAX);
      for (var i = 0; i < cells; i++) {
        this.noise[i] = (hash(i) - 0.5) * 0.22;
        this.tint[i] = hash(i * 7 + 11) < ORCHID_SHARE ? 1 : 0;
      }
    }
  };

  /* ---------- the frame ---------- */

  Field.prototype.draw = function (timeMs) {
    var t0 = performance.now();

    var ctx = this.ctx;
    var w = this.w;
    var h = this.h;
    ctx.clearRect(0, 0, w, h);

    var breath = Math.sin((timeMs / BREATH_MS) * Math.PI * 2);
    var sway = Math.sin((timeMs / (BREATH_MS * 1.7)) * Math.PI * 2);

    /* Bowl geometry, in CSS px. */
    var cx = w * 0.5 + sway * w * 0.012;
    var halfW = w * 0.5;
    var rimCentre = h * (0.74 + breath * 0.015);
    var depth = h * (0.52 + breath * 0.02);
    var band = h * 0.07 + 18; /* how hard the top edge is */
    var bottomFade = h * 0.88;
    var coreY = h * 0.92;
    var coreR = Math.max(w, h) * 0.62;

    /* Pointer, eased in and out so leaving does not snap. */
    this.pointerPower += (this.pointerTarget - this.pointerPower) * 0.12;
    var pw = this.pointerPower;
    var px = this.pointerX;
    var py = this.pointerY;
    var pr2 = POINTER_R * POINTER_R;

    var cols = this.cols;
    var rows = this.rows;
    var bucketOf = this.bucketOf;
    var noise = this.noise;
    var tint = this.tint;
    var counts = this.counts;
    var glyphAt = this.glyphAt;
    var glyphAlpha = this.glyphAlpha;
    var glyphCount = 0;
    var offsets = this.offsets;
    var order = this.order;
    var nB = STEPS * 2;
    var scale = (STEPS - 1) / (A_MAX - A_MIN);

    bucketOf.fill(-1);
    counts.fill(0);

    for (var gx = 0; gx < cols; gx++) {
      var xpx = gx * CELL + CELL * 0.5;
      var u = (xpx - cx) / halfW;
      var au = u < 0 ? -u : u;
      var horiz = 1 - smoothstep(0.7, 1.04, au);

      /* Columns and rows outside the bowl are normally skipped outright. The
         pointer reaches past it, so its neighbourhood is kept in play — the
         binary has to be able to appear above the rim, where the heading is. */
      var nearPointer =
        pw > 0.002 && dx0Abs(xpx, px) < GLYPH_R;

      if (horiz <= 0 && !nearPointer) continue;

      var rim = rimCentre - depth * u * u;
      var startRow = rim > 0 ? Math.floor(rim / CELL) : 0;
      if (nearPointer) {
        var pointerRow = Math.floor((py - GLYPH_R) / CELL);
        if (pointerRow < startRow) startRow = pointerRow;
      }
      if (startRow >= rows) continue;
      if (startRow < 0) startRow = 0;

      var bayerCol = (gx & 3) * 4;
      var dx0 = xpx - px;
      var dxCore = xpx - cx;

      for (var gy = startRow; gy < rows; gy++) {
        var ypx = gy * CELL + CELL * 0.5;
        var i = gy * cols + gx;

        /* Pointer proximity is resolved before the density test, because the
           binary reveal has to work over the sparse upper reaches of the bowl
           too — that is where the heading sits, and where a hand actually
           lands. Gating it on the dot pass would make it appear only in the
           dense middle, which is the one place nobody is pointing. */
        var boost = 0;
        var glyphPower = 0;
        if (pw > 0.002) {
          var dy0 = ypx - py;
          var dd = dx0 * dx0 + dy0 * dy0;
          if (dd < pr2) {
            var dist0 = Math.sqrt(dd);
            var f = 1 - dist0 / POINTER_R;
            boost = f * f * pw;
            if (dist0 < GLYPH_R) glyphPower = (1 - dist0 / GLYPH_R) * pw;
          }
        }

        if (glyphPower > GLYPH_MIN && glyphCount < GLYPH_MAX) {
          /* Its own falloff drives the alpha, so digits fade out toward the
             edge of the radius instead of ending on a hard circle. */
          var gStep = (glyphPower * (STEPS - 1) + 0.5) | 0;
          if (gStep < 0) gStep = 0;
          else if (gStep >= STEPS) gStep = STEPS - 1;
          glyphAt[glyphCount] = (gx << 16) | gy;
          /* A palette index, so glyphs reuse the quantised colours and no
             extra rgba strings are built per frame. */
          glyphAlpha[glyphCount] = tint[i] ? gStep + STEPS : gStep;
          glyphCount++;
          continue;
        }

        var dens = smoothstep(rim, rim + band, ypx);
        if (dens <= 0) continue;
        dens *= horiz;
        dens *= 1 - smoothstep(bottomFade, h * 1.02, ypx);
        if (dens <= 0.001) continue;

        /* Solid through the middle of the bowl, thinner out at its lip. */
        var dyCore = ypx - coreY;
        var distCore = Math.sqrt(dxCore * dxCore + dyCore * dyCore);
        dens *= 0.62 + 0.55 * (1 - smoothstep(0, coreR, distCore));

        var thr = 0.05 + 0.9 * BAYER[bayerCol + (gy & 3)] + noise[i] - boost * 0.3;
        if (dens <= thr) continue;

        var alpha = A_MIN + 0.5 * dens + boost * 0.55;
        if (alpha > A_MAX) alpha = A_MAX;

        var idx = ((alpha - A_MIN) * scale + 0.5) | 0;
        if (idx < 0) idx = 0;
        else if (idx >= STEPS) idx = STEPS - 1;

        var bucket = tint[i] ? idx + STEPS : idx;
        bucketOf[i] = bucket;
        counts[bucket]++;
      }
    }

    /* Counting sort into one reused index array, so each colour is
       drawn as a single run and fillStyle is set nB times a frame. */
    var run = 0;
    for (var c = 0; c < nB; c++) {
      offsets[c] = run;
      run += counts[c];
    }
    if (run === 0) {
      this.record(t0);
      return;
    }

    for (var y = 0; y < rows; y++) {
      var rowBase = y * cols;
      for (var x = 0; x < cols; x++) {
        var bAt = bucketOf[rowBase + x];
        if (bAt < 0) continue;
        order[offsets[bAt]++] = (x << 16) | y;
      }
    }

    var read = 0;
    for (var k = 0; k < nB; k++) {
      var n = counts[k];
      if (n === 0) continue;
      ctx.fillStyle = this.palette[k];
      var end = read + n;
      for (; read < end; read++) {
        var packed = order[read];
        ctx.fillRect(
          (packed >>> 16) * CELL + INSET,
          (packed & 0xffff) * CELL + INSET,
          DOT,
          DOT,
        );
      }
    }

    this.drawGlyphs(glyphAt, glyphAlpha, glyphCount);
    this.record(t0);
  };

  /**
   * Draw the cells nearest the pointer as binary digits.
   *
   * Which digit a cell shows is derived from its own index, so it stays the
   * same digit as the pointer passes over it — a per-frame random would flicker
   * into noise. Runs are grouped by palette bucket for the same reason the dot
   * pass is: one fillStyle assignment per colour, not one per glyph.
   */
  Field.prototype.drawGlyphs = function (at, bucketOf, count) {
    if (count === 0) return;
    var ctx = this.ctx;

    ctx.save();
    ctx.font = "600 " + GLYPH_SIZE + 'px "Geist Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    var current = -1;
    for (var g = 0; g < count; g++) {
      var bucket = bucketOf[g];
      if (bucket !== current) {
        current = bucket;
        ctx.fillStyle = this.glyphPalette[bucket];
      }
      var packed = at[g];
      var gx = packed >>> 16;
      var gy = packed & 0xffff;
      ctx.fillText(
        hash(gy * this.cols + gx + 3) < 0.5 ? "0" : "1",
        gx * CELL + CELL * 0.5,
        gy * CELL + CELL * 0.5,
      );
    }

    ctx.restore();
  };

  Field.prototype.record = function (t0) {
    var dt = performance.now() - t0;
    var s = this.stats;
    s.frames++;
    s.last = dt;
    s.avg = s.frames === 1 ? dt : s.avg + (dt - s.avg) * 0.05;
    if (dt > s.max) s.max = dt;
  };

  /* ---------- loop ---------- */

  Field.prototype.tick = function (now) {
    if (!this.running) return;
    if (!this.start0) this.start0 = now;
    this.draw(now - this.start0);
    this.raf = requestAnimationFrame(this.tick);
  };

  Field.prototype.start = function () {
    if (this.running || this.reduced.matches) return;
    this.running = true;
    this.start0 = 0;
    this.raf = requestAnimationFrame(this.tick);
  };

  Field.prototype.stop = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  /* ---------- input and lifecycle ---------- */

  Field.prototype.bindPointer = function () {
    this.host.addEventListener("pointermove", this.onPointerMove, { passive: true });
    this.host.addEventListener("pointerleave", this.onPointerLeave, { passive: true });
  };

  Field.prototype.unbindPointer = function () {
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerleave", this.onPointerLeave);
  };

  Field.prototype.onPointerMove = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    this.pointerX = e.clientX - rect.left;
    this.pointerY = e.clientY - rect.top;
    this.pointerTarget = 1;
  };

  Field.prototype.onPointerLeave = function () {
    this.pointerTarget = 0;
  };

  Field.prototype.onVisibility = function () {
    if (document.hidden) this.stop();
    else if (this.visible) this.start();
  };

  Field.prototype.observeVisibility = function () {
    var self = this;
    if (typeof IntersectionObserver !== "function") {
      this.visible = true;
      this.start();
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        var on = entries[entries.length - 1].isIntersecting;
        self.visible = on;
        if (on && !document.hidden) self.start();
        else self.stop();
      },
      { rootMargin: "15% 0px" },
    );
    io.observe(this.canvas);
  };

  Field.prototype.queueResize = function () {
    var self = this;
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(function () {
      self.resizeRaf = 0;
      var before = self.w + "x" + self.h;
      self.measure();
      if (before !== self.w + "x" + self.h || !self.running) self.draw(0);
    });
  };

  Field.prototype.observeResize = function () {
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(this.queueResize).observe(this.canvas);
    } else {
      window.addEventListener("resize", this.queueResize, { passive: true });
    }
  };

  /* ---------- boot ---------- */

  function boot() {
    var nodes = document.querySelectorAll("canvas[data-dither]");
    for (var i = 0; i < nodes.length; i++) {
      try {
        instances.push(new Field(nodes[i]));
      } catch (err) {
        /* A missing 2d context must not take the section down; the
           canvas is decorative and the copy above it stands alone. */
        console.warn("[adeia/dither] skipped a canvas:", err);
      }
    }
    window.__adeiaDither = instances;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
