/* Scroll reveals, and the ledger playing out one evening of invoices. */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- reveal on scroll ---------- */
  var targets = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    Array.prototype.forEach.call(targets, function (el) {
      el.classList.add("is-in");
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
    );
    Array.prototype.forEach.call(targets, function (el) {
      io.observe(el);
    });
  }

  /* ---------- the ledger ---------- */
  var rowsEl = document.getElementById("rows");
  var footEl = document.getElementById("foot");
  var spentEl = document.getElementById("spent");
  if (!rowsEl || !footEl || !spentEl) return;

  function money(cents) {
    return (
      "$" +
      (cents / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  var entries = [
    { t: "14:01:52", who: "acct_cloudhost · monthly hosting", cents: 2500, state: "executed" },
    { t: "14:01:58", who: "acct_mailgun · api overage", cents: 1250, state: "executed" },
    { t: "14:02:11", who: "acct_contractor · Q3 design work", cents: 50000, state: "held" },
  ];

  var spent = 0;

  function makeRow(e) {
    var li = document.createElement("li");
    li.className = "row" + (e.state === "held" ? " is-held" : "");

    var t = document.createElement("span");
    t.className = "row__t";
    t.textContent = e.t;

    var who = document.createElement("span");
    who.className = "row__who";
    who.textContent = e.who;

    var amt = document.createElement("span");
    amt.className = "row__amt";
    amt.textContent = money(e.cents);

    var chip = document.createElement("span");
    chip.className = "chip " + (e.state === "held" ? "chip--held breathe" : "chip--executed");
    chip.textContent = e.state === "held" ? "Held · awaiting approval" : "Executed";

    li.appendChild(t);
    li.appendChild(who);
    li.appendChild(amt);
    li.appendChild(chip);
    return { li: li, chip: chip };
  }

  function playStatic() {
    entries.forEach(function (e) {
      var made = makeRow(e);
      made.li.classList.add("is-in");
      rowsEl.appendChild(made.li);
      if (e.state === "executed") spent += e.cents;
    });
    spentEl.textContent = money(spent);
    footEl.textContent = "1 action held. Approve or deny from the email.";
  }

  function playAnimated() {
    var heldRow = null;
    var delay = 500;

    entries.forEach(function (e) {
      window.setTimeout(function () {
        var made = makeRow(e);
        rowsEl.appendChild(made.li);
        window.requestAnimationFrame(function () {
          made.li.classList.add("is-in");
        });

        if (e.state === "executed") {
          spent += e.cents;
          spentEl.textContent = money(spent);
        } else {
          heldRow = { li: made.li, chip: made.chip, cents: e.cents };
          footEl.textContent = "Approval request sent to you@example.com · waiting";
        }
      }, delay);
      delay += 1400;
    });

    /* The pause resolves the way it does in the product: a human decides. */
    window.setTimeout(function () {
      if (!heldRow) return;
      footEl.innerHTML =
        '<span class="is-approved">Approved by you@example.com at 14:03:47</span>';
      heldRow.li.classList.remove("is-held");
      heldRow.chip.className = "chip chip--executed";
      heldRow.chip.textContent = "Executed";
      spent += heldRow.cents;
      spentEl.textContent = money(spent);
    }, delay + 2400);
  }

  if (reduced) {
    playStatic();
    return;
  }

  /* Hold the sequence until the ledger is actually on screen. */
  if ("IntersectionObserver" in window) {
    var seen = false;
    var ledgerIo = new IntersectionObserver(
      function (entries2) {
        if (seen || !entries2[0].isIntersecting) return;
        seen = true;
        ledgerIo.disconnect();
        playAnimated();
      },
      { threshold: 0.25 },
    );
    ledgerIo.observe(rowsEl);
  } else {
    playAnimated();
  }
})();
