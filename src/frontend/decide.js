/**
 * Adeia — the approval page, playable.
 *
 * The phone above it shows the mail that arrives. This is the page the
 * link in that mail opens, and pressing either button does what the real
 * one does: the trail writes itself, and what it writes depends on which
 * you pressed.
 *
 * Approve and the action reaches its adapter. Deny and it never does —
 * the trail simply ends at the decision, which is the single most
 * important thing this product can demonstrate and the hardest thing to
 * show in a still picture.
 *
 * The events and their order are the real ones from audit/log.ts. The
 * times are relative and made up; nothing else here is.
 */

const M = window.Motion;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

/* What the trail says, either way. `hold` is the beat before the line
   lands — the gap after approval.granted is where the adapter is
   actually working. */
const TRAILS = {
  approve: [
    { t: "14:03:47", e: "approval.granted", d: "{ decidedBy: 'you@example.com' }", tone: "ok", hold: 260 },
    { t: "14:03:47", e: "action.executing", d: "{ adapter: 'http' }", tone: "", hold: 420 },
    { t: "14:03:47", e: "action.executed", d: "{ status: 204 }", tone: "mark", hold: 0 },
  ],
  deny: [
    { t: "14:03:47", e: "approval.denied", d: "{ decidedBy: 'you@example.com' }", tone: "mark", hold: 420 },
    { t: "", e: "", d: "the adapter was never reached", tone: "dim", hold: 0 },
  ],
};

const SUMMARY = {
  approve: "Approved. The record was deleted, and the trail says who let it through.",
  deny: "Refused. Nothing was sent, and the trail says who stopped it.",
};

for (const card of document.querySelectorAll("[data-decide]")) wire(card);

function wire(card) {
  const act = card.querySelector("[data-decide-act]");
  const fine = card.querySelector("[data-decide-fine]");
  const trail = card.querySelector("[data-decide-trail]");
  const again = card.querySelector("[data-decide-again]");
  const yes = card.querySelector("[data-decide-yes]");
  const no = card.querySelector("[data-decide-no]");
  if (!act || !trail || !again || !yes || !no) return;

  let busy = false;

  const choose = async (which) => {
    if (busy) return;
    busy = true;

    card.dataset.decided = which;
    /* Both buttons go at once. A real single-use token does not leave
       the other option sitting there afterwards. */
    act.hidden = true;
    fine.textContent =
      which === "approve"
        ? "Decided. This link cannot be used again."
        : "Decided. Nothing was sent, and this link cannot be used again.";

    for (const row of TRAILS[which]) {
      await beat(row.hold ? 0 : 0);
      trail.append(line(row));
      const el = trail.lastElementChild;

      if (M && !reduced.matches) {
        M.animate(
          el,
          { opacity: [0, 1], transform: ["translateY(6px)", "translateY(0px)"] },
          { type: "spring", stiffness: 320, damping: 28, mass: 0.6 },
        );
      }

      await beat(reduced.matches ? 0 : row.hold);
    }

    const sum = document.createElement("p");
    sum.className = "decide__sum";
    sum.textContent = SUMMARY[which];
    trail.append(sum);
    if (M && !reduced.matches) {
      M.animate(sum, { opacity: [0, 1] }, { duration: 0.35 });
    }

    again.hidden = false;
    busy = false;
  };

  yes.addEventListener("click", () => choose("approve"));
  no.addEventListener("click", () => choose("deny"));

  again.addEventListener("click", () => {
    if (busy) return;
    trail.replaceChildren();
    again.hidden = true;
    act.hidden = false;
    delete card.dataset.decided;
    fine.textContent =
      "The request has not been sent. Nothing downstream has been contacted. This link can be used once.";
    yes.focus();
  });
}

function line({ t, e, d, tone }) {
  const row = document.createElement("p");
  row.className = "decide__row";
  if (tone) row.dataset.tone = tone;

  if (t) {
    const time = document.createElement("span");
    time.className = "decide__t";
    time.textContent = t;
    row.append(time);
  }

  if (e) {
    const name = document.createElement("span");
    name.className = "decide__e";
    name.textContent = e;
    row.append(name);
  }

  const data = document.createElement("span");
  data.className = "decide__d";
  data.textContent = d;
  row.append(data);

  return row;
}

const beat = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
