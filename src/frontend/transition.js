/**
 * Adeia — moving between pages.
 *
 * Any same-origin link: the Explore dock folds away first, then whatever is
 * on screen melts (the wordmark, a page's object, the icons), then the page
 * swooshes down to the next one (a cross-document view transition, in
 * os.css), where that page's object reforms out of the water.
 *
 * Four melts and four reforms; each destination gets its own pairing,
 * chosen by a hash of where it is, so going to Policy always looks like
 * going to Policy and differently from going to Proof.
 *
 * Modified clicks, new tabs, downloads, anchors on the same page, sign-in
 * and sign-out, and reduced motion all get the plain browser behaviour.
 */
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const MELT_MS = 1300;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;
  let busy = false;

  document.addEventListener("click", async (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return;
    if (url.pathname.startsWith("/auth")) return;

    e.preventDefault();
    if (busy) return;
    busy = true;

    const h = hash(url.pathname + url.search);
    const melt = h % 4;
    const form = (h >>> 2) % 4;

    const dockOpen = document.querySelector(".os-dock.is-open");
    dispatchEvent(new Event("adeia:dock-close"));
    if (dockOpen) await wait(380);

    try {
      sessionStorage.setItem("adeia-arrive", JSON.stringify({ melt, form, at: Date.now() }));
    } catch {}
    dispatchEvent(new CustomEvent("adeia:melt", { detail: { mode: melt, ms: MELT_MS } }));
    await wait(MELT_MS - 80);
    location.href = url.href;
  });

  // The flag is read by hero3d/objects3d on load; clear it once they have.
  setTimeout(() => { try { sessionStorage.removeItem("adeia-arrive"); } catch {} }, 4000);
  addEventListener("pageshow", (e) => { if (e.persisted) busy = false; });
})();
