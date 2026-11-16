/* Adeia OS — the menubar, the notch, the Explore dock, the windows and
   the theme switch, for every page that sets data-os on <html>.

   Loaded synchronously in <head> so the theme is on <html> before the
   first paint. Everything else waits for the document.

   Enhancement only: with this file missing, every page still reads. */
(() => {
  const root = document.documentElement;
  const KEY = "adeia-theme";

  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch {}
  // The desk is light by default, as the reference is; dark is a choice.
  root.dataset.theme = stored === "dark" ? "dark" : "light";

  const mode = root.dataset.os; // "site" (the desk), "page", or "app"
  if (!mode) return;

  // [path, label, icon, file name shown under it]
  const PAGES = [
    ["/", "Desktop", "folder", "home"],
    ["/how", "How it works", "readme", "how.md"],
    ["/capability", "Capability", "capability", "capability.key"],
    ["/approach", "Approach", "approach", "approach.md"],
    ["/policy", "Policy", "policy", "policy.yaml"],
    ["/quickstart", "Quickstart", "quickstart", "quickstart.sh"],
    ["/sdk", "SDK", "sdk", "sdk.ts"],
    ["/audit", "Audit log", "audit", "audit.log"],
    ["/proof", "Proof", "proof", "proof.pdf"],
    ["/contact", "Contact", "contact", "contact.eml"],
    ["/dashboard", "Dashboard", "dashboard", "Dashboard.app"],
  ];

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wide = () => matchMedia("(min-width: 861px)").matches;
  const here = location.pathname.replace(/\.html$/, "").replace(/\/index$/, "/") || "/";

  const h = (tag, attrs = {}, html = "") => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.innerHTML = html;
    return el;
  };

  const svg = (d, w = 2) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const SUN = svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>');
  const MOON = svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>');
  const OUT = svg('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>');
  const X = svg('<path d="M6 6l12 12M18 6L6 18"/>', 3.5);
  const MINUS = svg('<path d="M5 12h14"/>', 3.5);

  function start() {
    const body = document.body;
    body.prepend(h("div", { class: "os-ground", "aria-hidden": "true" }));

    /* ---------- menubar ---------- */
    const theme = h("button", { class: "os-chip os-theme", type: "button" });
    const paintTheme = () => {
      const dark = root.dataset.theme === "dark";
      theme.innerHTML = `${dark ? MOON : SUN}<span class="os-theme__label">${dark ? "Dark" : "Light"}</span><span class="os-switch" aria-hidden="true"></span>`;
      theme.setAttribute("aria-pressed", String(dark));
      theme.setAttribute("aria-label", `Dark theme ${dark ? "on" : "off"}`);
    };
    paintTheme();
    theme.addEventListener("click", () => {
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, root.dataset.theme); } catch {}
      paintTheme();
    });

    const clock = h("span", { class: "os-chip os-chip--clock" });
    const fmt = new Intl.DateTimeFormat(undefined, {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
    const tick = () => { clock.innerHTML = `<i class="os-dot" aria-hidden="true"></i>${fmt.format(new Date())}`; };
    tick();
    setInterval(tick, 20_000);

    const cta =
      mode === "app"
        ? h("a", { class: "os-chip os-chip--ink", href: "https://adeia.xyz" }, `adeia.xyz ${OUT}`)
        : h("a", { class: "os-chip os-chip--ink", href: "/dashboard" }, `Dashboard ${OUT}`);

    const end = h("div", { class: "os-bar__end" });
    end.append(theme, clock, cta);
    const bar = h("nav", { class: "os-bar", "aria-label": "Menu bar" });
    bar.append(h("a", { class: "os-chip os-brand", href: "/" }, 'Adeia<span class="os-brand__long">&nbsp;permission layer</span>©'), end);
    body.prepend(bar);

    /* ---------- the notch ---------- */
    const announce = document.querySelector(".announce b");
    const notchTitle =
      root.dataset.notchTitle || (mode === "app" && announce ? announce.textContent.trim() : "Fence armed");
    const notchSub =
      root.dataset.notchSub ||
      (mode === "app"
        ? announce && /waiting/.test(announce.textContent) ? "an action needs your decision" : "nothing is waiting on you"
        : "agents ask · rules decide · you approve");
    const notch = h(
      "div",
      { class: "os-notch", role: "status", tabindex: "0" },
      `<span class="os-notch__glyph" aria-hidden="true"></span>
       <span class="os-notch__text"><b>${notchTitle}</b><span>${notchSub}</span></span>
       <span class="os-notch__cam" aria-hidden="true"></span>`,
    );
    body.prepend(notch);
    const openNotch = (on) => notch.classList.toggle("is-open", on);
    notch.addEventListener("mouseenter", () => openNotch(true));
    notch.addEventListener("mouseleave", () => openNotch(false));
    notch.addEventListener("focus", () => openNotch(true));
    notch.addEventListener("blur", () => openNotch(false));
    if (!reduced) {
      setTimeout(() => openNotch(true), 900);
      setTimeout(() => { if (!notch.matches(":hover, :focus")) openNotch(false); }, 4200);
    }

    /* ---------- the Explore dock ---------- */
    const apps = PAGES.map(
      ([href, label, icon, file], i) =>
        `<a class="os-dock__app" href="${href}" style="--i:${i}"${href === here ? ' aria-current="page"' : ""}>
           <img src="/3d/icon-${icon}.webp" alt="" width="56" height="56" loading="lazy">
           <span>${label}</span><small>${file}</small>
         </a>`,
    ).join("");
    const dock = h(
      "div",
      { class: "os-dock" },
      `<div class="os-dock__panel"><div class="os-dock__inner" id="os-explore">
         <div class="os-dock__grid">${apps}</div>
         <div class="os-dock__min" aria-label="Minimised windows"></div>
       </div></div>
       <div class="os-dock__bar">
         <a class="os-dock__logo" href="/" aria-label="Adeia home">a<i>.</i></a>
         <button class="os-dock__toggle" type="button" aria-expanded="false" aria-controls="os-explore">Explore</button>
         <button class="os-dock__burger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="os-explore"><span></span></button>
       </div>`,
    );
    const scrim = h("div", { class: "os-scrim", "aria-hidden": "true" });
    body.append(scrim, dock);

    const toggles = dock.querySelectorAll(".os-dock__toggle, .os-dock__burger");
    const tray = dock.querySelector(".os-dock__min");
    const label = dock.querySelector(".os-dock__toggle");
    const setDock = (on) => {
      dock.classList.toggle("is-open", on);
      scrim.classList.toggle("is-on", on);
      for (const t of toggles) t.setAttribute("aria-expanded", String(on));
    };
    for (const t of toggles) t.addEventListener("click", () => setDock(!dock.classList.contains("is-open")));
    scrim.addEventListener("click", () => setDock(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setDock(false); });

    const paintTray = () => {
      const n = tray.children.length;
      label.innerHTML = n ? `Explore <b>${n}</b>` : "Explore";
    };

    /* ---------- windows ---------- */
    let z = 10;
    const front = (win) => { win.style.zIndex = String(++z); };

    function chrome(win, title, { onClose } = {}) {
      const foot = win.querySelector(":scope > .win__foot");
      const inner = h("div", { class: "win__inner" });
      const content = h("div", { class: "win__body" });
      for (const node of [...win.childNodes]) if (node !== foot) content.append(node);
      const barEl = h(
        "div",
        { class: "win__bar" },
        `<div class="win__lights">
           <button class="win__light win__light--close" type="button" aria-label="Close ${title}">${X}</button>
           <button class="win__light win__light--min" type="button" aria-label="Minimise ${title}">${MINUS}</button>
         </div>
         <div class="win__title">${title}</div><span></span>`,
      );
      inner.append(barEl, content);
      if (foot) inner.append(foot);
      win.append(inner);
      win.addEventListener("pointerdown", () => front(win));

      barEl.querySelector(".win__light--close").addEventListener("click", () => {
        if (onClose) return onClose();
        win.hidden = true;
        document.querySelectorAll(".ico.is-selected").forEach((i) => i.classList.remove("is-selected"));
      });
      barEl.querySelector(".win__light--min").addEventListener("click", () => minimise(win, title));
      if (win.classList.contains("win--float")) drag(win, barEl);
    }

    function minimise(win, title) {
      const r = win.getBoundingClientRect();
      const dr = dock.getBoundingClientRect();
      win.style.setProperty("--to-x", `${dr.left + dr.width / 2 - (r.left + r.width / 2)}px`);
      win.style.setProperty("--to-y", `${dr.top - (r.top + r.height / 2)}px`);
      win.classList.add("is-min");
      win.dispatchEvent(new CustomEvent("os:min"));
      const b = h("button", { type: "button" }, title);
      b.addEventListener("click", () => {
        win.classList.remove("is-min");
        win.dispatchEvent(new CustomEvent("os:restore"));
        front(win);
        b.remove();
        paintTray();
        setDock(false);
      });
      tray.append(b);
      paintTray();
    }

    function drag(win, handle) {
      handle.addEventListener("pointerdown", (e) => {
        if (!wide() || e.target.closest(".win__light")) return;
        const desk = win.offsetParent.getBoundingClientRect();
        const r0 = win.getBoundingClientRect();
        const dx = e.clientX - r0.left;
        const dy = e.clientY - r0.top;
        win.classList.add("is-dragging");
        handle.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const x = Math.min(Math.max(ev.clientX - dx - desk.left, -r0.width + 120), desk.width - 120);
          const y = Math.min(Math.max(ev.clientY - dy - desk.top, 56), desk.height - 60);
          win.style.setProperty("--x", `${x}px`);
          win.style.setProperty("--y", `${y}px`);
        };
        const up = () => {
          win.classList.remove("is-dragging");
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
    }

    if (mode === "site") {
      for (const win of document.querySelectorAll(".win[data-win]")) chrome(win, win.dataset.title);

      for (const ico of document.querySelectorAll("[data-open]")) {
        ico.addEventListener("click", () => {
          const win = document.querySelector(`.win[data-win="${ico.dataset.open}"]`);
          if (!win) return;
          document.querySelectorAll(".ico.is-selected").forEach((i) => i.classList.remove("is-selected"));
          ico.classList.add("is-selected");
          win.hidden = false;
          win.classList.remove("is-min", "is-opening");
          void win.offsetWidth;
          win.classList.add("is-opening");
          front(win);
        });
      }

      /* Desktop files move. Press and drag past a few pixels and the icon
         follows the pointer; let go and it stays, remembered for this
         browser. A press that never travels is still a click and opens the
         window, so dragging never costs you the old behaviour. Wide screens
         only — on a phone the icons are a list, not a desk. */
      const deskEl = document.querySelector(".desk");
      const SPOTS = "adeia-desk-spots";
      let spots = {};
      try { spots = JSON.parse(localStorage.getItem(SPOTS) || "{}"); } catch {}
      const keyOf = (ico) => ico.dataset.open || ico.getAttribute("href") || "";
      const place = (ico, x, y) => {
        ico.style.left = `${x}%`;
        ico.style.top = `${y}%`;
      };
      for (const ico of document.querySelectorAll(".desk .ico")) {
        const saved = spots[keyOf(ico)];
        if (saved && wide()) place(ico, saved[0], saved[1]);
        ico.draggable = false;
        ico.querySelector("img")?.setAttribute("draggable", "false");
        let moved = false;
        ico.addEventListener("pointerdown", (e) => {
          if (!wide() || !deskEl || e.button !== 0) return;
          const box = deskEl.getBoundingClientRect();
          const r0 = ico.getBoundingClientRect();
          const dx = e.clientX - r0.left;
          const dy = e.clientY - r0.top;
          const sx = e.clientX, sy = e.clientY;
          moved = false;
          const move = (ev) => {
            if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
            if (!moved) { moved = true; ico.setPointerCapture(e.pointerId); ico.classList.add("is-dragging"); }
            const x = Math.min(Math.max(ev.clientX - dx - box.left, 0), box.width - r0.width);
            const y = Math.min(Math.max(ev.clientY - dy - box.top, 48), box.height - r0.height - 80);
            place(ico, (x / box.width) * 100, (y / box.height) * 100);
          };
          const up = () => {
            ico.removeEventListener("pointermove", move);
            ico.removeEventListener("pointerup", up);
            ico.removeEventListener("pointercancel", up);
            if (!moved) return;
            ico.classList.remove("is-dragging");
            ico.classList.add("is-dropped");
            setTimeout(() => ico.classList.remove("is-dropped"), 700);
            spots[keyOf(ico)] = [parseFloat(ico.style.left), parseFloat(ico.style.top)];
            try { localStorage.setItem(SPOTS, JSON.stringify(spots)); } catch {}
          };
          ico.addEventListener("pointermove", move);
          ico.addEventListener("pointerup", up);
          ico.addEventListener("pointercancel", up);
        });
        // A drag that ends over the icon would otherwise fire its click.
        ico.addEventListener("click", (e) => {
          if (moved) { e.preventDefault(); e.stopImmediatePropagation(); moved = false; }
        }, true);
      }

      const desk = document.querySelector(".desk");
      if (desk && !reduced) {
        let raf = 0;
        desk.addEventListener("pointermove", (e) => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            desk.style.setProperty("--px", ((e.clientX / innerWidth) * 2 - 1).toFixed(3));
            desk.style.setProperty("--py", ((e.clientY / innerHeight) * 2 - 1).toFixed(3));
          });
        });
      }
    } else {
      // A whole page in one window. The footer comes inside with it.
      const main = document.querySelector("main");
      if (!main) return;
      const win = h("div", { class: "win win--page" });
      main.before(win);
      win.append(main);
      const foot = document.querySelector("body > footer");
      if (foot) win.append(foot);
      const title = root.dataset.title || document.title.split(" — ")[0];
      chrome(win, title, {
        onClose: mode === "app" ? () => minimise(win, title) : () => { location.href = "/"; },
      });

      // Each doc page shows its own 3D object where the old hero field was.
      const page = PAGES.find(([href]) => href === here);
      const hero = document.querySelector(".phero");
      if (page && hero) {
        hero.append(h("img", { class: "os-page-art", src: `/3d/icon-${page[2]}.webp`, alt: "", "aria-hidden": "true", width: "256", height: "256" }));
      }

      const art = h("img", { class: "os-desk-art", src: "/3d/hero.webp", alt: "", "aria-hidden": "true" });
      body.append(art);
      win.addEventListener("os:min", () => art.classList.add("is-on"));
      win.addEventListener("os:restore", () => art.classList.remove("is-on"));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
