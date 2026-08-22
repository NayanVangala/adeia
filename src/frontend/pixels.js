/**
 * Adeia — the pixel mask.
 *
 * runrobrun.com closes on a section covered by a 12x9 grid of solid cells with
 * a colour underneath; moving the pointer across clears cells from the top
 * layer so the colour shows through. It is the most distinctive thing on that
 * page, and it is one grid and one pointer handler.
 *
 * Here the mask means something. It is the fence: solid until something is let
 * through, closing again behind. So a cleared cell restores itself after a
 * moment rather than staying open, which is both the truer metaphor and the
 * reason the effect never degrades into a permanently erased grid.
 *
 * Cleared by proximity rather than by direct hover, so a fast pointer leaves a
 * swept trail instead of a single lit square. All of it is skipped under
 * reduced motion and on a device with no hovering pointer, where a mask that
 * cannot be cleared would simply hide the line underneath.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const canHover = window.matchMedia("(hover: hover)");

for (const mask of document.querySelectorAll("[data-pixels]")) {
  const cells = [...mask.children];
  if (!cells.length) continue;

  /* Without a pointer the mask can never open, so it is removed rather than
     left covering the line it is sitting on top of. */
  if (reduced.matches || !canHover.matches) {
    mask.remove();
    continue;
  }

  const COLS = 12;
  const RADIUS = 1.35;
  const HOLD_MS = 620;
  const timers = new WeakMap();

  const clear = (cell) => {
    cell.classList.add("is-clear");
    clearTimeout(timers.get(cell));
    timers.set(
      cell,
      setTimeout(() => cell.classList.remove("is-clear"), HOLD_MS),
    );
  };

  /* One rect per move rather than one per cell: reading a rect off every one
     of 108 cells on every pointer event is a layout thrash the effect does not
     need. Column and row come from arithmetic instead. */
  mask.addEventListener(
    "pointermove",
    (event) => {
      const rect = mask.getBoundingClientRect();
      const cw = rect.width / COLS;
      const ch = rect.height / (cells.length / COLS);
      const px = (event.clientX - rect.left) / cw;
      const py = (event.clientY - rect.top) / ch;

      for (let i = 0; i < cells.length; i += 1) {
        const dx = (i % COLS) + 0.5 - px;
        const dy = Math.floor(i / COLS) + 0.5 - py;
        if (dx * dx + dy * dy <= RADIUS * RADIUS) clear(cells[i]);
      }
    },
    { passive: true },
  );
}
