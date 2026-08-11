/* ---------------------------------------------------------------
   Menu panel and in-page navigation.

   The masthead toggle opens a full-screen panel of the sections that
   exist on this page. A link carrying data-open-band also opens that
   band of the capability accordion once the scroll has settled, so it
   lands on its own content rather than on whatever was last open.
   --------------------------------------------------------------- */
(function () {
  "use strict";

  var button = document.getElementById("menu-button");
  var panel = document.querySelector("[data-menu-panel]");
  var label = document.querySelector("[data-menu-label]");
  var glyph = document.querySelector("[data-menu-glyph]");

  /* ---------- the panel ---------- */

  if (button && panel) {
    var lastFocused = null;

    var focusables = function () {
      return Array.prototype.slice.call(panel.querySelectorAll("a[href], button:not([disabled])"));
    };

    var setOpen = function (open) {
      button.setAttribute("aria-expanded", open ? "true" : "false");
      if (label) label.textContent = open ? "Close" : "Menu";
      if (glyph) glyph.textContent = open ? "×" : "+";

      if (open) {
        lastFocused = document.activeElement;
        panel.hidden = false;
        document.documentElement.style.overflow = "hidden";
        /* Next frame, so the transition has a from-state to run from — and so
           the focus lands after visibility flips. Calling focus() while the
           panel is still `visibility: hidden` is silently ignored. */
        window.requestAnimationFrame(function () {
          panel.setAttribute("data-open", "true");
          var first = focusables()[0];
          if (first) first.focus();
        });
      } else {
        panel.setAttribute("data-open", "false");
        document.documentElement.style.overflow = "";
        /* Kept in the tree until the fade finishes, then taken out of it
           entirely so its links are not tabbable behind the page. */
        window.setTimeout(function () {
          if (panel.getAttribute("data-open") !== "true") panel.hidden = true;
        }, 700);
        if (lastFocused && lastFocused.focus) lastFocused.focus();
      }
    };

    var isOpen = function () {
      return button.getAttribute("aria-expanded") === "true";
    };

    button.addEventListener("click", function () {
      setOpen(!isOpen());
    });

    /* Following a link should not leave the panel covering the target. */
    panel.addEventListener("click", function (e) {
      var link = e.target.closest ? e.target.closest("a[href]") : null;
      if (link) setOpen(false);
    });

    document.addEventListener("keydown", function (e) {
      if (!isOpen()) return;

      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }

      /* Keep tabbing inside the panel while it covers everything else. */
      if (e.key === "Tab") {
        var items = focusables();
        if (items.length === 0) return;
        var first = items[0];
        var last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    setOpen(false);
  }

  /* ---------- links that open an accordion band ---------- */

  /**
   * A link carrying data-open-band scrolls to the capability section and
   * opens the named band, so it lands on its own content rather than on
   * whatever was open. Nothing on the page uses it right now — the footer
   * links go to real pages — but the menu is the obvious next caller.
   */
  document.addEventListener("click", function (e) {
    var link = e.target.closest ? e.target.closest("[data-open-band]") : null;
    if (!link) return;
    var band = link.getAttribute("data-open-band");
    var trigger = document.getElementById("cap-trigger-" + band);
    if (!trigger) return;
    /* Let the browser do the scroll; open the band once it has settled. */
    window.setTimeout(function () {
      if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    }, 450);
  });
})();
