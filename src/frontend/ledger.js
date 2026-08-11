/* ---------------------------------------------------------------
   The proof ledger.

   Plays one evening of invoices against the seed policy: two clear on
   their own, the third crosses the per-action limit, stops, waits for a
   human, and resolves. The verdict card tracks whatever the ledger is
   currently waiting on.

   All money is integer cents; formatting happens at the edge only.
   Markup contract lives in partials/proof.html — this file builds the
   rows that styles/proof.css already describes.
   --------------------------------------------------------------- */
(function () {
  "use strict";

  var stage = document.querySelector("[data-ledger]");
  if (!stage) return;

  var rowsEl = stage.querySelector("[data-ledger-rows]");
  var spentEl = stage.querySelector("[data-ledger-spent]");
  var footEl = stage.querySelector("[data-ledger-foot]");
  var verdictEl = stage.querySelector("[data-ledger-verdict]");
  var vAmtEl = stage.querySelector("[data-ledger-verdict-amt]");
  var vRuleEl = stage.querySelector("[data-ledger-verdict-rule]");
  var vReasonEl = stage.querySelector("[data-ledger-verdict-reason]");
  var vWhoEl = stage.querySelector("[data-ledger-verdict-who]");
  if (!rowsEl || !spentEl || !footEl) return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Seed policy, same figures as scripts/seed.ts. */
  var PER_ACTION_CENTS = 5000;
  var APPROVER = "you@example.com";

  var ENTRIES = [
    {
      time: "14:01:52",
      acct: "acct_cloudhost",
      memo: "monthly hosting",
      cents: 2500,
      outcome: "executed",
    },
    {
      time: "14:01:58",
      acct: "acct_mailgun",
      memo: "api overage",
      cents: 1250,
      outcome: "executed",
    },
    {
      time: "14:02:11",
      acct: "acct_contractor",
      memo: "Q3 design work",
      cents: 50000,
      outcome: "held",
    },
  ];

  function money(cents) {
    return (
      "$" +
      (cents / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  function span(cls, text) {
    var el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function buildRow(entry) {
    var li = document.createElement("li");
    li.className = "proof__row";
    li.setAttribute("data-outcome", entry.outcome);

    var who = document.createElement("span");
    who.className = "proof__who";
    who.appendChild(span("proof__acct", entry.acct));
    who.appendChild(span("proof__memo", entry.memo));

    li.appendChild(span("proof__time mono", entry.time));
    li.appendChild(who);
    li.appendChild(span("proof__amt mono", money(entry.cents)));

    var state = span(
      "proof__state",
      entry.outcome === "held" ? "Held · awaiting approval" : "Executed",
    );
    li.appendChild(state);

    return { li: li, state: state };
  }

  var spent = 0;

  function addSpend(cents) {
    spent += cents;
    spentEl.textContent = money(spent);
  }

  function setVerdict(state, fields) {
    if (!verdictEl) return;
    verdictEl.setAttribute("data-state", state);
    if (vAmtEl) vAmtEl.textContent = fields.amount || "";
    if (vRuleEl) vRuleEl.textContent = fields.rule || "";
    if (vReasonEl) vReasonEl.textContent = fields.reason || "";
    if (vWhoEl) vWhoEl.textContent = fields.who || "";
  }

  var HELD = ENTRIES[2];

  var VERDICT_HELD = {
    amount: money(HELD.cents),
    rule:
      "Over the $50.00 per-action limit, so it stopped before the adapter was " +
      "called and a human was asked.",
    reason:
      "amount " + HELD.cents + " exceeds per-action limit " + PER_ACTION_CENTS,
    who: "Sent to " + APPROVER + " · waiting",
  };

  var VERDICT_APPROVED = {
    amount: money(HELD.cents),
    rule:
      "Approved, then executed. The decision and the person who made it are " +
      "both in the audit log.",
    reason: "approval.granted → action.executing → action.executed",
    who: "Approved by " + APPROVER + " at 14:03:47",
  };

  function resolveHeld(row) {
    row.li.setAttribute("data-outcome", "approved");
    row.state.textContent = "Executed · approved";
    addSpend(HELD.cents);
    footEl.textContent =
      "Approved at 14:03:47. Recorded, not settled — no processor is attached.";
    setVerdict("approved", VERDICT_APPROVED);
  }

  function playStatic() {
    ENTRIES.forEach(function (entry) {
      var row = buildRow(entry);
      row.li.classList.add("is-in");
      rowsEl.appendChild(row.li);
      if (entry.outcome === "executed") addSpend(entry.cents);
      else resolveHeld(row);
    });
  }

  function playSequence() {
    var delay = 600;
    var heldRow = null;

    ENTRIES.forEach(function (entry) {
      window.setTimeout(function () {
        var row = buildRow(entry);
        rowsEl.appendChild(row.li);
        window.requestAnimationFrame(function () {
          row.li.classList.add("is-in");
        });

        if (entry.outcome === "executed") {
          addSpend(entry.cents);
          footEl.textContent = "Inside the fence. Executed without asking anyone.";
        } else {
          heldRow = row;
          footEl.textContent =
            "Over the per-action limit. Approval request sent to " +
            APPROVER +
            " · waiting.";
          setVerdict("held", VERDICT_HELD);
        }
      }, delay);
      delay += 1400;
    });

    /* The pause resolves the way it does in the product: a human decides. */
    window.setTimeout(function () {
      if (heldRow) resolveHeld(heldRow);
    }, delay + 2200);
  }

  if (reduced) {
    playStatic();
    return;
  }

  /* Hold the sequence until the ledger is actually on screen, so it is not
     already over by the time anyone scrolls to it. */
  if ("IntersectionObserver" in window) {
    var started = false;
    var io = new IntersectionObserver(
      function (entries) {
        if (started || !entries[0].isIntersecting) return;
        started = true;
        io.disconnect();
        playSequence();
      },
      { threshold: 0.25 },
    );
    io.observe(stage);
  } else {
    playSequence();
  }
})();
