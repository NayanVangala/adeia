/* ---------------------------------------------------------------
   Visit counter.

   Records this visit against Adeia's own backend and shows the figure it
   returns. The count is deduplicated server-side per visitor per UTC day,
   so it reports unique visitor-days rather than page loads — which is what
   the label next to it says.

   If the backend is unreachable, the element stays hidden. A counter that
   falls back to a plausible-looking number is not a counter.
   --------------------------------------------------------------- */
(function () {
  "use strict";

  var host = document.querySelector("[data-visits]");
  if (!host) return;

  var totalEl = host.querySelector("[data-visits-total]");
  if (!totalEl) return;

  /* Same origin unless the page names an API elsewhere, which it does in
     development, where the site is on :5173 and the server on :3000. */
  var meta = document.querySelector('meta[name="adeia-api"]');
  var base = (meta && meta.getAttribute("content")) || "";
  var url = base.replace(/\/+$/, "") + "/v1/site/visits";

  if (!("fetch" in window)) return;

  /* Give up quickly. This is a footer ornament; it must never be the reason
     something else on the page is waiting. */
  var controller = "AbortController" in window ? new AbortController() : null;
  var timer = window.setTimeout(function () {
    if (controller) controller.abort();
  }, 4000);

  fetch(url, {
    method: "POST",
    headers: { accept: "application/json" },
    signal: controller ? controller.signal : undefined,
    /* No credentials: the endpoint is anonymous and we want no cookies on it. */
    credentials: "omit",
    cache: "no-store",
  })
    .then(function (res) {
      if (!res.ok) throw new Error("visits " + res.status);
      return res.json();
    })
    .then(function (data) {
      var total = Number(data && data.total);
      if (!Number.isFinite(total) || total < 0) throw new Error("bad payload");
      totalEl.textContent = total.toLocaleString("en-US");
      host.hidden = false;
    })
    .catch(function () {
      /* Stays hidden. Deliberately silent — a landing page should not log
         noise into the console because an ornament could not load. */
    })
    .finally(function () {
      window.clearTimeout(timer);
    });
})();
