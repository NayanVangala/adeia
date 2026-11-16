/**
 * Adeia — the boot screen.
 *
 * Loaded synchronously as the first thing in <body>, so it covers the page
 * before anything else paints. Dust swirls in and settles into the orbit
 * ring around the "a." mark while the page loads underneath; a hairline
 * bar tracks it; a word ticker rolls at the foot.
 *
 * Once per tab: sessionStorage remembers it ran, so moving between pages
 * does not replay it. Never under prefers-reduced-motion. If storage is
 * unavailable it simply runs, which is harmless.
 *
 * It lifts on window load *and* the live wordmark's first frame
 * (`adeia:hero-ready`), whichever comes last, after at least MIN_MS, and
 * never later than MAX_MS — a hung request does not hold the page hostage.
 */
(() => {
  const MIN_MS = 1400;
  const MAX_MS = 5000;
  const KEY = "adeia-booted";

  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, "1");
  } catch {}

  const root = document.createElement("div");
  root.className = "boot";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <canvas class="boot__dust"></canvas>
    <div class="boot__bar"><i></i></div>
    <div class="boot__foot">
      <span>ADEIA</span>
      <span class="boot__roll"><b>PERMISSION</b><b>POLICY</b><b>APPROVAL</b><b>PROOF</b><b>PERMISSION</b></span>
    </div>`;
  document.body.prepend(root);
  document.documentElement.classList.add("is-booting");

  const canvas = root.querySelector("canvas");
  const bar = root.querySelector(".boot__bar i");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  let w = 0, h = 0;
  function size() {
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  addEventListener("resize", size);

  /* Each particle has a home on the ring (angle) and a start far out. */
  const N = 900;
  const dots = Array.from({ length: N }, () => ({
    a: Math.random() * Math.PI * 2,
    jitter: (Math.random() - 0.5) * 0.16,
    from: 1.6 + Math.random() * 3.5,
    spin: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3),
    r: 0.6 + Math.random() ** 3 * 1.8,
    hue: Math.random(),
    delay: Math.random() * 0.35,
  }));

  const t0 = performance.now();
  let progress = 0;   // what the bar shows
  let target = 0.15;  // what we know
  let loaded = document.readyState === "complete";
  let heroReady = !document.querySelector("img.desk__hero, img.dash-3d");
  let leaving = 0;

  addEventListener("load", () => { loaded = true; });
  addEventListener("adeia:hero-ready", () => { heroReady = true; });
  document.querySelectorAll("img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", () => { target = Math.min(0.85, target + 0.05); }, { once: true });
  });

  const ease = (x) => 1 - Math.pow(1 - x, 3);

  function draw(now) {
    const el = now - t0;
    target = Math.max(target, Math.min(0.85, el / 2500));
    if (loaded && heroReady) target = 1;
    progress += (target - progress) * 0.08;
    bar.style.transform = `scaleX(${progress.toFixed(3)})`;

    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2 - 20;
    const R = Math.min(w, h) * 0.14;
    const tilt = -0.35;
    const spinNow = el / 1000 * 0.6;

    for (const d of dots) {
      const k = ease(Math.min(1, Math.max(0, (progress - d.delay) / (1 - d.delay))));
      const rad = R * (1 + d.jitter) * (k + (1 - k) * d.from);
      const ang = d.a + spinNow + (1 - k) * d.spin;
      // A circle squashed into an ellipse and tilted: the orbit seen at an angle.
      const ex = Math.cos(ang) * rad;
      const ey = Math.sin(ang) * rad * 0.38;
      const x = cx + ex * Math.cos(tilt) - ey * Math.sin(tilt);
      const y = cy + ex * Math.sin(tilt) + ey * Math.cos(tilt);
      const front = Math.sin(ang) > 0 ? 1 : 0.55;
      ctx.globalAlpha = (0.25 + 0.75 * k) * front * (1 - leaving);
      ctx.fillStyle = d.hue < 0.12 ? "#ffffff" : `hsl(${232 + d.hue * 40} 95% ${62 + d.hue * 12}%)`;
      ctx.beginPath();
      ctx.arc(x, y, d.r * (0.7 + 0.5 * k), 0, Math.PI * 2);
      ctx.fill();
    }

    // The mark, fading in as the ring closes.
    ctx.globalAlpha = Math.min(1, progress * 1.4) * (1 - leaving);
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 ${Math.round(R * 0.62)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("a.", cx, cy);
    ctx.globalAlpha = 1;

    const done = (progress > 0.985 && el > MIN_MS) || el > MAX_MS;
    if (done && !leaving) lift();
    if (!root.isConnected) return;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  function lift() {
    leaving = 0.001;
    root.classList.add("is-leaving");
    document.documentElement.classList.remove("is-booting");
    const fade = () => { leaving = Math.min(1, leaving + 0.06); if (leaving < 1) requestAnimationFrame(fade); };
    fade();
    root.addEventListener("transitionend", () => root.remove(), { once: true });
    setTimeout(() => root.remove(), 1500);
  }
})();
