/**
 * Adeia — the three things on the landing page that play rather than sit.
 *
 * A terminal that replays the demo, a diagram with an action travelling
 * through it, and a pair of budget meters that show the same runaway
 * agent hitting a fence and not hitting one.
 *
 * All three share the same two rules. Nothing starts until it is on
 * screen, and nothing is only in the animation: every line, every node
 * and every figure is in the markup or is written back at the end, so a
 * reader with no JavaScript, or one who asked for no motion, gets the
 * finished state rather than an empty box.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Runs `fn` the first time `el` is scrolled into view. */
function onceVisible(el, fn) {
  if (!("IntersectionObserver" in window)) {
    fn();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.disconnect();
        fn();
      }
    },
    { rootMargin: "0px 0px -15% 0px", threshold: 0.15 },
  );

  observer.observe(el);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 1. The terminal replays the demo.
 *
 * Line by line rather than character by character: the lines carry
 * markup, and typing through a coloured span one character at a time
 * means rebuilding it on every frame for an effect nobody can tell
 * apart from this one at terminal speed.
 *
 * The pause before the approval line is the point of the whole scene,
 * so it is the longest wait in it.
 * ------------------------------------------------------------------ */

function replay() {
  for (const pre of document.querySelectorAll("[data-replay]")) {
    const lines = [...pre.querySelectorAll(".tl")];
    if (!lines.length) return;

    if (reduced.matches) {
      pre.setAttribute("data-replay-done", "");
      continue;
    }

    /* Reserve the finished height before hiding anything, or the pane
       grows as it plays and shoves the page down under the reader. */
    pre.style.minHeight = `${pre.getBoundingClientRect().height}px`;
    pre.setAttribute("data-replaying", "");

    onceVisible(pre, async () => {
      for (const line of lines) {
        await wait(Number(line.dataset.in ?? 120));
        line.setAttribute("data-shown", "");
        /* The held line keeps the caret until the wait after it ends,
           so the cursor is visibly sitting there doing nothing. */
        if (line.hasAttribute("data-hold")) pre.setAttribute("data-held", "");
      }
      pre.removeAttribute("data-held");
      pre.removeAttribute("data-replaying");
      pre.setAttribute("data-replay-done", "");
    });
  }
}

/* ------------------------------------------------------------------ *
 * 2. An action travels the diagram.
 *
 * The strokes already draw themselves on entry. This sends something
 * along them afterwards and lights each node as it arrives, so the
 * picture reads as a path rather than as a chart. It takes the branch
 * to the person, because that is the branch the section is about.
 * ------------------------------------------------------------------ */

/* Which line leads to which node, in the order an action meets them.
   Indices are into the SVG's own children, so the diagram stays the
   single source of truth for its shape. */
const ROUTE = [
  { line: 0, node: 1 }, // agent  -> schema
  { line: 1, node: 2 }, // schema -> policy
  { line: 3, node: 4 }, // policy -> you        (the warm branch)
  { line: 5, node: 5 }, // you    -> adapter
];

function flow() {
  const svg = document.querySelector(".flow svg");
  if (!svg || reduced.matches) return;

  const lines = [...svg.querySelectorAll(".flow__line")];
  const nodes = [...svg.querySelectorAll(".flow__node")];
  if (lines.length <= 5 || nodes.length <= 5) return;

  const ns = "http://www.w3.org/2000/svg";
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("r", "4");
  dot.setAttribute("class", "flow__dot");
  dot.setAttribute("opacity", "0");
  svg.append(dot);

  onceVisible(svg, () => {
    let leg = 0;
    let started = 0;

    function step(now) {
      const path = lines[ROUTE[leg].line];
      const length = path.getTotalLength();
      /* A constant speed rather than a constant duration, so a long leg
         takes longer than a short one and the thing reads as travelling
         rather than as being dealt out. */
      const duration = (length / 150) * 1000;

      if (!started) started = now;
      const t = Math.min((now - started) / duration, 1);
      const at = path.getPointAtLength(length * t);

      dot.setAttribute("cx", at.x);
      dot.setAttribute("cy", at.y);
      dot.setAttribute("opacity", "1");

      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }

      /* Arrived. Light the node, then set off again — or stop, if this
         was the adapter and the action has run. */
      nodes[ROUTE[leg].node].classList.add("is-lit");
      started = 0;
      leg += 1;

      if (leg < ROUTE.length) {
        /* The wait on the person is the long one, for the same reason
           it is in the terminal. */
        setTimeout(() => requestAnimationFrame(step), leg === 3 ? 1400 : 260);
      } else {
        dot.setAttribute("opacity", "0");
      }
    }

    nodes[0].classList.add("is-lit");
    setTimeout(() => requestAnimationFrame(step), 900);
  });
}

/* ------------------------------------------------------------------ *
 * 3. The same runaway agent, with a fence and without one.
 *
 * Both meters start on the same budget and take the same retry loop.
 * The unfenced one empties. The fenced one stops at the per-action
 * limit and waits for a person, which is the whole difference the
 * section is claiming and was previously two bullet lists.
 * ------------------------------------------------------------------ */

const BUDGET = 200000; /* $2,000.00 in integer cents, as everywhere else */
const PER_CALL = 24000; /* $240.00 a retry */
const LIMIT = 5000; /* $50.00 per action */

function burn() {
  const meters = [...document.querySelectorAll("[data-burn]")];
  if (!meters.length) return;

  for (const meter of meters) {
    const fenced = meter.hasAttribute("data-burn-fenced");
    const figure = meter.querySelector("[data-burn-figure]");
    const fill = meter.querySelector("[data-burn-fill]");
    const state = meter.querySelector("[data-burn-state]");
    const count = meter.querySelector("[data-burn-count]");

    /* The end state, written into the markup as the no-JS answer and as
       what reduced motion gets. */
    const settle = () => {
      const left = fenced ? BUDGET : 0;
      figure.textContent = money(left);
      fill.style.width = `${(left / BUDGET) * 100}%`;
      count.textContent = fenced ? "1" : String(Math.ceil(BUDGET / PER_CALL));
      state.textContent = fenced
        ? "held at $50.00 — waiting on a person"
        : "budget gone, and nobody was asked";
      meter.setAttribute("data-burn-state-name", fenced ? "held" : "spent");
    };

    if (reduced.matches) {
      settle();
      continue;
    }

    onceVisible(meter, async () => {
      let left = BUDGET;
      let calls = 0;

      while (left > 0) {
        /* The fence answers before the money moves, so the fenced meter
           never spends anything at all — the first call is already over
           the per-action limit. */
        if (fenced && PER_CALL > LIMIT) {
          calls += 1;
          count.textContent = String(calls);
          meter.setAttribute("data-burn-state-name", "held");
          state.textContent = "held at $50.00 — waiting on a person";
          return;
        }

        left = Math.max(0, left - PER_CALL);
        calls += 1;

        figure.textContent = money(left);
        fill.style.width = `${(left / BUDGET) * 100}%`;
        count.textContent = String(calls);
        state.textContent = "retrying…";

        await wait(190);
      }

      meter.setAttribute("data-burn-state-name", "spent");
      state.textContent = "budget gone, and nobody was asked";
    });
  }
}

/** Integer cents to a display string, without ever holding a float. */
function money(cents) {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${
    rest < 10 ? `0${rest}` : rest
  }`;
}

replay();
flow();
burn();
