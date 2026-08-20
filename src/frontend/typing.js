/**
 * Adeia — headlines that type themselves.
 *
 * The naive typewriter walks a string and writes it into textContent,
 * which flattens every element inside the heading. These headlines are
 * not plain strings: each one carries a `<span class="sweep">` around
 * the phrase that matters, and several carry a `<br>`. Flattening them
 * would throw away the one piece of colour on the page and the line
 * break the composition depends on.
 *
 * So this walks the text nodes instead. Every character keeps the parent
 * it was born in, the markup is never rebuilt, and the accent phrase
 * arrives already amber rather than being recoloured at the end.
 *
 * The text is in the document the whole time. It is emptied at runtime
 * and refilled, never generated — so with no JavaScript, or with reduced
 * motion, the heading is simply there. Screen readers get the finished
 * heading too: the element is marked aria-busy while it types and the
 * live text is never announced character by character.
 */

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

/* Characters a second. Fast enough not to be a wait, slow enough to
   read as typing rather than as a wipe. */
const RATE = 46;

/* A pause where a human would take one. Long enough to notice, short
   enough that nobody thinks it has stalled. */
const PAUSE = {
  ",": 190,
  ".": 240,
  "—": 190,
  ":": 160,
};

function collect(el) {
  /* Every text node under the heading, in document order, with the text
     it started with. */
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue) continue;
    nodes.push({ node, full: node.nodeValue });
  }

  /* Markup indentation puts whitespace at both ends of a heading. HTML
     collapses it away, so it draws nothing — but typing it still costs
     time, and the caret sits blinking past the last visible character
     for as long as it takes. Trim the outer edges only; whitespace
     between words is real and stays. */
  if (nodes.length) {
    const first = nodes[0];
    first.full = first.full.replace(/^\s+/, "");
    const last = nodes[nodes.length - 1];
    last.full = last.full.replace(/\s+$/, "");
  }

  return nodes.filter((n) => n.full.length > 0);
}

/**
 * Empties an element and holds its finished size.
 *
 * Every target in a group is prepared before any of them types, not each
 * one as its turn arrives. Preparing late means the line under a heading
 * sits there fully written while the heading types above it, and then
 * blanks itself — which reads as a bug rather than as an effect.
 *
 * Pinning the height first is what stops the page jumping: an emptied
 * heading is zero tall, and three of them collapsing at once moves
 * everything below by several hundred pixels.
 */
function prepare(el) {
  const parts = collect(el);
  if (!parts.length) return null;

  el.style.minHeight = `${el.getBoundingClientRect().height}px`;
  for (const p of parts) p.node.nodeValue = "";
  el.setAttribute("aria-busy", "true");

  return parts;
}

function type(el, parts) {
  if (!parts || !parts.length) return Promise.resolve();

  el.dataset.typing = "";

  return new Promise((resolve) => {
    let part = 0;
    let index = 0;
    let last = 0;
    let owed = 0;

    function frame(now) {
      if (!last) last = now;
      /* Clamped, so a backgrounded tab does not dump the whole heading
         out in one frame on return. */
      owed += Math.min((now - last) / 1000, 1 / 20) * RATE;
      last = now;

      let pause = 0;

      while (owed >= 1 && part < parts.length) {
        const p = parts[part];
        const ch = p.full[index];
        p.node.nodeValue += ch;
        index += 1;
        owed -= 1;

        if (index >= p.full.length) {
          part += 1;
          index = 0;
        }

        if (PAUSE[ch]) {
          pause = PAUSE[ch];
          break;
        }
      }

      if (part >= parts.length) {
        el.removeAttribute("aria-busy");
        delete el.dataset.typing;
        el.style.minHeight = "";
        resolve();
        return;
      }

      if (pause) {
        last = 0;
        setTimeout(() => requestAnimationFrame(frame), pause);
      } else {
        requestAnimationFrame(frame);
      }
    }

    requestAnimationFrame(frame);
  });
}

/* Each group types in order: the heading, then whatever follows it, so a
   hero reads top to bottom the way somebody would write it. */
const groups = document.querySelectorAll("[data-type-group]");
if (groups.length && !reduced.matches) {
  for (const group of groups) {
    /* Emptied now, typed when it is looked at. Waiting until the group
       is on screen to empty it means anything below the fold shows its
       finished text and then blanks as you reach it. */
    const prepared = [...group.querySelectorAll("[data-type]")].map((el) => [
      el,
      prepare(el),
    ]);

    const play = async () => {
      for (const [el, parts] of prepared) {
        await type(el, parts);
        await new Promise((r) => setTimeout(r, 120));
      }
    };

    /* A hero is on screen from the first frame, so on a page with the
       loader it would type itself out behind the panel and be finished
       before anyone saw it. Wait for the panel to leave. */
    const gate = document.querySelector("[data-loader]")
      ? new Promise((r) =>
          document.addEventListener("adeia:ready", r, { once: true }),
        )
      : Promise.resolve();

    if (!("IntersectionObserver" in window)) {
      gate.then(play);
      continue;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        gate.then(play);
      },
      { threshold: 0.25 },
    );
    observer.observe(group);
  }
}
