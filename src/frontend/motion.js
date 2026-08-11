/* ---------------------------------------------------------------
   Adeia — page motion

   Three things, in this order of importance:

   1. Nothing here may leave text invisible. The resting states in
      motion.css only apply while <html> carries .motion-ready, which
      this file adds and, on any failure, takes away again. A watchdog
      does the same if the vendor bundles never arrive. That is the
      whole safety story: if motion dies, the page renders plainly.
   2. Reveals. Headings split into masked lines and rise from 100%;
      anything with .js-reveal fades and rises 24px.
   3. Grounds. The page background eases between section ground
      colours over 1500ms so the four grounds flow rather than abut.

   Loads GSAP, ScrollTrigger, SplitText and Lenis from ./vendor by
   relative path. Works loaded as a module or as a classic script.
   --------------------------------------------------------------- */

(function () {
  "use strict";

  var root = document.documentElement;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* Where this file lives, so ./vendor resolves the same whether the
     page loads us as a module or a classic script. */
  var HERE = (document.currentScript && document.currentScript.src) || null;
  function vendorUrl(name) {
    return HERE ? new URL("vendor/" + name, HERE).href : "./vendor/" + name;
  }

  var REVEAL_SEL = ".js-reveal";
  var SPLIT_SEL = ".js-split";
  var GROUNDS = { ink: "--ink", bone: "--bone", paper: "--paper", forest: "--forest" };

  var aborted = false;
  var watchdog = 0;
  var splits = [];
  var lenis = null;

  /* Resting states go on before anything else so there is no flash of
     un-animated content, and come off the moment anything is wrong. */
  if (!reduced.matches) {
    root.classList.add("motion-ready");
    watchdog = window.setTimeout(function () {
      unlock("vendor bundles did not load in time");
    }, 3000);
  }

  /* The single recovery path. Strips every resting state and any
     inline style GSAP may have left, so all content renders plainly. */
  function unlock(reason) {
    aborted = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = 0;
    }
    root.classList.remove("motion-ready", "ground-driven");

    for (var i = 0; i < splits.length; i++) {
      try {
        splits[i].revert();
      } catch (err) {
        /* nothing useful to do; the class strip below still applies */
      }
    }
    splits.length = 0;

    var nodes = document.querySelectorAll(REVEAL_SEL + "," + SPLIT_SEL);
    for (var n = 0; n < nodes.length; n++) {
      var el = nodes[n];
      el.classList.remove("is-split");
      el.style.removeProperty("opacity");
      el.style.removeProperty("transform");
      el.style.removeProperty("visibility");
      el.style.removeProperty("will-change");
    }

    if (lenis) {
      try {
        lenis.destroy();
      } catch (err2) {
        /* ignore */
      }
      lenis = null;
    }
    document.body.style.removeProperty("background-color");

    if (reason) console.warn("[adeia/motion] motion disabled:", reason);
  }

  /* ---------- easing ----------
     GSAP core cannot parse a cubic-bezier string without CustomEase,
     which is not vendored, so the two tokens are solved here and
     registered by name. Same curves as --ease-out / --ease-io. */
  function bezier(x1, y1, x2, y2) {
    var cx = 3 * x1;
    var bx = 3 * (x2 - x1) - cx;
    var ax = 1 - cx - bx;
    var cy = 3 * y1;
    var by = 3 * (y2 - y1) - cy;
    var ay = 1 - cy - by;

    function sampleX(t) {
      return ((ax * t + bx) * t + cx) * t;
    }
    function sampleY(t) {
      return ((ay * t + by) * t + cy) * t;
    }
    function slopeX(t) {
      return (3 * ax * t + 2 * bx) * t + cx;
    }

    return function (p) {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      var t = p;
      for (var i = 0; i < 8; i++) {
        var x = sampleX(t) - p;
        if (Math.abs(x) < 1e-5) return sampleY(t);
        var d = slopeX(t);
        if (Math.abs(d) < 1e-6) break;
        t -= x / d;
      }
      var lo = 0;
      var hi = 1;
      t = p;
      for (var j = 0; j < 24; j++) {
        var xv = sampleX(t);
        if (Math.abs(xv - p) < 1e-5) break;
        if (p > xv) lo = t;
        else hi = t;
        t = (hi + lo) / 2;
      }
      return sampleY(t);
    };
  }

  /* ---------- vendor loading ---------- */

  /* The vendor bundles are UMD. Imported as ES modules they run in
     strict mode and die assigning window.window, so they are injected
     as classic scripts and read back off the global. */
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.async = false;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error("failed to load " + url));
      };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  function need(name, global) {
    if (window[global]) return Promise.resolve();
    return loadScript(vendorUrl(name)).then(function () {
      if (!window[global]) throw new Error(name + " loaded but did not define " + global);
    });
  }

  function loadVendor() {
    /* Sequential: the plugins look for window.gsap as they evaluate. */
    return need("gsap.min.js", "gsap")
      .then(function () {
        return need("ScrollTrigger.min.js", "ScrollTrigger");
      })
      .then(function () {
        return need("SplitText.min.js", "SplitText").catch(function (err) {
          /* Optional. Headings fall back to a plain reveal. */
          console.warn("[adeia/motion] SplitText unavailable:", err);
        });
      })
      .then(function () {
        return need("lenis.min.js", "Lenis").catch(function (err) {
          console.warn("[adeia/motion] Lenis unavailable:", err);
        });
      });
  }

  /* ---------- smooth scroll ---------- */

  function startLenis(gsap, ScrollTrigger) {
    if (!window.Lenis) return;
    lenis = new window.Lenis({
      lerp: 0.1,
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 1.6,
      autoRaf: false,
    });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(function (time) {
      lenis.raf(time * 1000);
    });
    gsap.ticker.lagSmoothing(0);
  }

  /* ---------- heading reveals ---------- */

  function plainReveal(gsap, el, delay) {
    el.classList.add("is-split");
    gsap.fromTo(
      el,
      { opacity: 0, y: 24 },
      {
        opacity: 1,
        y: 0,
        duration: 0.7,
        delay: delay || 0,
        ease: "adeia-out",
        overwrite: "auto",
        scrollTrigger: { trigger: el, start: "top 88%", once: true },
      },
    );
  }

  function initSplits(gsap) {
    var SplitText = window.SplitText;
    var nodes = gsap.utils.toArray(SPLIT_SEL);

    nodes.forEach(function (el) {
      if (!SplitText) {
        plainReveal(gsap, el, 0);
        return;
      }
      try {
        var split = SplitText.create(el, {
          type: "lines",
          mask: "lines",
          linesClass: "splitline",
          autoSplit: true,
          onSplit: function (self) {
            /* Returned so autoSplit reverts it before re-splitting. */
            return gsap.from(self.lines, {
              yPercent: 100,
              duration: 0.7,
              ease: "adeia-out",
              stagger: 0.08,
              scrollTrigger: { trigger: el, start: "top 85%", once: true },
            });
          },
        });
        splits.push(split);
        el.classList.add("is-split");
      } catch (err) {
        console.warn("[adeia/motion] split failed, falling back:", err);
        plainReveal(gsap, el, 0);
      }
    });
  }

  /* ---------- generic reveals ---------- */

  function initReveals(gsap) {
    gsap.utils.toArray(REVEAL_SEL).forEach(function (el) {
      var delay = parseFloat(el.getAttribute("data-delay") || "0");
      if (!isFinite(delay) || delay < 0) delay = 0;
      gsap.fromTo(
        el,
        { opacity: 0, y: 24 },
        {
          opacity: 1,
          y: 0,
          duration: 0.7,
          delay: delay / 1000,
          ease: "adeia-out",
          overwrite: "auto",
          scrollTrigger: { trigger: el, start: "top 88%", once: true },
        },
      );
    });
  }

  /* ---------- ground transitions ---------- */

  function initGrounds(gsap, ScrollTrigger) {
    var styles = getComputedStyle(root);
    var sections = [];

    Array.prototype.forEach.call(document.querySelectorAll(".ground"), function (el) {
      for (var key in GROUNDS) {
        if (!Object.prototype.hasOwnProperty.call(GROUNDS, key)) continue;
        if (!el.classList.contains("ground--" + key)) continue;
        var colour = styles.getPropertyValue(GROUNDS[key]).trim();
        if (colour) sections.push({ el: el, colour: colour });
        return;
      }
    });

    if (!sections.length) return;

    /* Body carries the colour; the sections go transparent so the
       whole page crossfades instead of the sections butting up. Both
       are undone by unlock(). */
    var current = sections[0].colour;
    document.body.style.backgroundColor = current;
    root.classList.add("ground-driven");

    function to(colour) {
      if (colour === current) return;
      current = colour;
      gsap.to(document.body, {
        backgroundColor: colour,
        duration: 1.5,
        ease: "adeia-io",
        overwrite: true,
      });
    }

    sections.forEach(function (s) {
      ScrollTrigger.create({
        trigger: s.el,
        start: "top 60%",
        end: "bottom 60%",
        onEnter: function () {
          to(s.colour);
        },
        onEnterBack: function () {
          to(s.colour);
        },
      });
    });
  }

  /* ---------- boot ---------- */

  function domReady() {
    if (document.readyState !== "loading") return Promise.resolve();
    return new Promise(function (resolve) {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }

  function init() {
    /* Reduced motion: no resting states were applied, no vendor is
       loaded, no listeners are bound. motion.css does the rest. */
    if (reduced.matches) return Promise.resolve();

    return domReady()
      .then(loadVendor)
      .then(function () {
        if (aborted) return;
        var gsap = window.gsap;
        var ScrollTrigger = window.ScrollTrigger;
        if (!gsap || !ScrollTrigger) throw new Error("gsap or ScrollTrigger missing");

        gsap.registerPlugin(ScrollTrigger);
        if (window.SplitText) gsap.registerPlugin(window.SplitText);

        gsap.registerEase("adeia-out", bezier(0.165, 0.84, 0.44, 1));
        gsap.registerEase("adeia-io", bezier(0.77, 0, 0.175, 1));

        startLenis(gsap, ScrollTrigger);
        initSplits(gsap);
        initReveals(gsap);
        initGrounds(gsap, ScrollTrigger);
        ScrollTrigger.refresh();

        if (watchdog) {
          clearTimeout(watchdog);
          watchdog = 0;
        }
        window.__adeiaMotion = { gsap: gsap, lenis: lenis, splits: splits, unlock: unlock };
      });
  }

  init().catch(function (err) {
    unlock(err && err.message ? err.message : String(err));
  });

  /* If the preference is switched on mid-session, drop everything
     rather than leaving half a system running. */
  if (reduced.addEventListener) {
    reduced.addEventListener("change", function (e) {
      if (e.matches) unlock(null);
    });
  }
})();
