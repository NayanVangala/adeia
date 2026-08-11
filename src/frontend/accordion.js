/* ---------------------------------------------------------------
   Adeia — Capability band accordion

   State lives here, not in :hover, because three inputs move the
   same thing and CSS can only see one of them:

     pinned  the band the reader last clicked. -1 = none.
     active  the band currently open. Hover and focus borrow it;
             when both let go it falls back to pinned.

   The markup already ships with band one open, so if this file
   never loads the section still reads. Everything below only ever
   moves which band is open.
   --------------------------------------------------------------- */

(function () {
  "use strict";

  var PREV_KEYS = ["ArrowLeft", "ArrowUp", "Left", "Up"];
  var NEXT_KEYS = ["ArrowRight", "ArrowDown", "Right", "Down"];

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function hasHover() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: hover)").matches
    );
  }

  function initAccordion(root) {
    var bands = Array.prototype.slice.call(
      root.querySelectorAll("[data-cap-band]"),
    );
    if (bands.length === 0) return;

    var triggers = [];
    var panels = [];
    var i;

    for (i = 0; i < bands.length; i += 1) {
      triggers.push(bands[i].querySelector("[data-cap-trigger]"));
      panels.push(bands[i].querySelector("[data-cap-panel]"));
      if (!triggers[i]) return; // malformed markup: leave the CSS state alone
    }

    // Whichever band the markup shipped open is the initial pin.
    var pinned = 0;
    for (i = 0; i < bands.length; i += 1) {
      if (bands[i].getAttribute("data-open") === "true") {
        pinned = i;
        break;
      }
    }
    var active = pinned;

    function render() {
      for (var n = 0; n < bands.length; n += 1) {
        var open = n === active;
        bands[n].setAttribute("data-open", open ? "true" : "false");
        triggers[n].setAttribute("aria-expanded", open ? "true" : "false");
        if (panels[n]) {
          if (open) panels[n].removeAttribute("aria-hidden");
          else panels[n].setAttribute("aria-hidden", "true");
        }
      }
    }

    function setActive(next) {
      if (next === active) return;
      active = next;
      render();
    }

    /* Where the row should sit when nothing is hovered: the focused
       band if the keyboard is in here, otherwise the pinned one. */
    function restingIndex() {
      var focused = triggers.indexOf(document.activeElement);
      return focused === -1 ? pinned : focused;
    }

    function bindBand(band, index) {
      band.addEventListener("click", function (event) {
        // Clicks inside the open panel are for reading and selecting
        // text, not for closing the thing being read.
        if (
          panels[index] &&
          typeof event.target.closest === "function" &&
          event.target.closest("[data-cap-panel]")
        ) {
          return;
        }
        if (pinned === index && active === index) {
          pinned = -1;
          setActive(-1);
        } else {
          pinned = index;
          setActive(index);
        }
      });

      triggers[index].addEventListener("keydown", function (event) {
        var delta = 0;
        if (PREV_KEYS.indexOf(event.key) !== -1) delta = -1;
        else if (NEXT_KEYS.indexOf(event.key) !== -1) delta = 1;

        var target = -1;
        if (delta !== 0) {
          target = (index + delta + bands.length) % bands.length;
        } else if (event.key === "Home") {
          target = 0;
        } else if (event.key === "End") {
          target = bands.length - 1;
        }

        if (target === -1) return;
        event.preventDefault();
        triggers[target].focus(); // focusin opens it
      });
    }

    for (i = 0; i < bands.length; i += 1) {
      bindBand(bands[i], i);
    }

    // Keyboard: focus opens, leaving the row returns it to the pin.
    root.addEventListener("focusin", function (event) {
      var index = triggers.indexOf(event.target);
      if (index !== -1) setActive(index);
    });

    root.addEventListener("focusout", function (event) {
      if (event.relatedTarget && root.contains(event.relatedTarget)) return;
      setActive(pinned);
    });

    // Pointer: only on devices that actually hover, and never when
    // the reader has asked for less movement.
    if (hasHover() && !prefersReducedMotion()) {
      for (i = 0; i < bands.length; i += 1) {
        (function (index) {
          bands[index].addEventListener("mouseenter", function () {
            setActive(index);
          });
        })(i);
      }
      root.addEventListener("mouseleave", function () {
        setActive(restingIndex());
      });
    }

    render();
  }

  function init() {
    var roots = document.querySelectorAll(".capability__accordion");
    for (var i = 0; i < roots.length; i += 1) {
      initAccordion(roots[i]);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
