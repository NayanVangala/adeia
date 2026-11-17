/**
 * Adeia — moving between pages.
 *
 * Any same-origin link: the Explore dock folds away and, at the same moment,
 * whatever is on screen melts; then the page swooshes down (a cross-document
 * view transition, in os.css) to the next page, whose object reforms out of
 * the water.
 *
 * The next page is prerendered as soon as a link is hovered, pressed or
 * focused, so by the time the melt ends it is already loaded, its models
 * decoded and its shaders built; the change itself is instant. Where the
 * browser cannot prerender, it is prefetched instead.
 *
 * Four melts and four reforms; each destination has its own pairing, from a
 * hash of where it is (look3d.js hashPath), so the new page can work out its
 * reform without being told.
 *
 * Modified clicks, new tabs, downloads, anchors on the same page, sign-in
 * and sign-out, and reduced motion all get the plain browser behaviour.
 */
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  /* Arriving from another page of the site: hide the still images from the
     very first paint, so the reform starts from water rather than flashing
     the finished object first. hero3d/objects3d clear this once drawn; if
     they never are, it lifts by itself. */
  try {
    const ref = new URL(document.referrer);
    const nav = performance.getEntriesByType("navigation")[0];
    if (ref.origin === location.origin && ref.href !== location.href && nav?.type !== "reload") {
      document.documentElement.classList.add("is-arriving");
      setTimeout(() => document.documentElement.classList.remove("is-arriving"), 4000);
    }
  } catch {}

  const MELT_MS = 950;
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;
  const canPrerender = HTMLScriptElement.supports?.("speculationrules");
  const warmed = new Set();
  let busy = false;

  const target = (el) => {
    const a = el?.closest?.("a[href]");
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return null;
    if (url.pathname === location.pathname && url.search === location.search) return null;
    if (url.pathname.startsWith("/auth")) return null;
    return url;
  };

  function warm(url) {
    if (warmed.has(url.href) || warmed.size > 6) return;
    warmed.add(url.href);
    if (canPrerender) {
      const s = document.createElement("script");
      s.type = "speculationrules";
      s.textContent = JSON.stringify({ prerender: [{ source: "list", urls: [url.href], eagerness: "immediate" }] });
      document.head.append(s);
    } else {
      const l = document.createElement("link");
      l.rel = "prefetch";
      l.href = url.href;
      document.head.append(l);
    }
  }

  for (const type of ["pointerover", "pointerdown", "focusin"]) {
    document.addEventListener(type, (e) => { const u = target(e.target); if (u) warm(u); }, { passive: true });
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = target(e.target);
    if (!url) return;
    e.preventDefault();
    if (busy) return;
    busy = true;
    warm(url);
    dispatchEvent(new Event("adeia:dock-close"));
    dispatchEvent(new CustomEvent("adeia:melt", { detail: { mode: hash(url.pathname + url.search) % 4, ms: MELT_MS } }));
    setTimeout(() => { location.href = url.href; }, MELT_MS - 60);
  });

  addEventListener("pageshow", (e) => { if (e.persisted) busy = false; });
})();
