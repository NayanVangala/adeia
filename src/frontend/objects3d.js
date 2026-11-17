/**
 * Adeia — every object on the site, live.
 *
 * Each <img> of a 3D object (the desktop icons, a doc page's art, the
 * dashboard's stat and tab art) is replaced by the real model, drawn by one
 * shared WebGL canvas fixed over the page. Every frame each object is drawn
 * into its image's own box with a scissored viewport, so it scrolls, drags
 * and lays out exactly as the image did. The image stays as the poster: it
 * is what shows before this loads, without WebGL, or if anything throws.
 *
 * Big objects (a page's art) get real transmission; icon-sized ones get an
 * opaque stand-in, because a transmission pass per icon costs a full render.
 *
 * Listens for `adeia:melt` (from transition.js) and plays the melt; on
 * arrival from another page, plays the matching reform.
 */

import { THREE, studio, material, meltable, droplets, tween, arrival, shown } from "/look3d.js?v=1794869433658";
import { GLTFLoader } from "/vendor/GLTFLoader.js";
import { DRACOLoader } from "/vendor/DRACOLoader.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const BIG = 200; // px: at and above this an object gets real glass

let imgs = [];

/* Glass refracts what was drawn before it, into a render target the screen
   never sees. A backdrop drawn only there gives the glass something to bend
   without ever painting over the page in front of the reader. */
function onlyInRefraction(mesh) {
  mesh.material.depthWrite = false;
  mesh.onBeforeRender = (renderer) => { mesh.material.colorWrite = renderer.getRenderTarget() !== null; };
}

async function start() {
  // os.js adds a doc page's art when it starts, which can be after this
  // module runs; it says so when it has.
  const root = document.documentElement;
  if (root.dataset.os && !root.dataset.osReady) await new Promise((r) => addEventListener("adeia:os-ready", r, { once: true }));
  imgs = [...document.querySelectorAll('img[src*="/3d/icon-"], img[data-obj]')].filter((img) => !img.closest(".os-dock, .boot"));
  if (!imgs.length) return;

  const canvas = document.createElement("canvas");
  canvas.className = "objects3d";
  canvas.setAttribute("aria-hidden", "true");
  // On the landing desk the objects sit under the windows; elsewhere they sit
  // over the page body (which is itself a window) but under the dock and notch.
  canvas.style.zIndex = document.querySelector(".desk") ? "6" : "50";

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  studio(renderer, scene);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  camera.position.set(0, 0, 7.4);

  const draco = new DRACOLoader().setDecoderPath("/vendor/draco/");
  const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync("/3d/objects.glb");
  const library = new Map(gltf.scene.children.map((n) => [n.name, n]));

  const objects = [];
  for (const img of imgs) {
    const name = img.dataset.obj || (img.src.match(/icon-([a-z]+)\./) || [])[1];
    const source = library.get(name);
    if (!source) continue;
    const big = img.getBoundingClientRect().width >= BIG;

    const model = source.clone(true);
    const box = new THREE.Box3().setFromObject(model);
    const uniforms = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = material(o.material?.name || "Amber", { big });
      uniforms.push(meltable(o.material, box.min.y, box.max.y));
    });
    const drops = droplets(big ? 320 : 120, box);
    drops.uniforms.uScale.value = big ? 1.6 : 0.8;
    model.add(drops.points);

    // Fit: bounding sphere to radius 1, centred.
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fit = new THREE.Group();
    fit.scale.setScalar(1 / sphere.radius);
    model.position.copy(sphere.center).multiplyScalar(-1);
    fit.add(model);

    // The same three-quarter view the icons were rendered from.
    const pose = new THREE.Group();
    pose.rotation.set(0.32, -0.42, 0);
    pose.add(fit);
    const holder = new THREE.Group();
    holder.add(pose);
    holder.visible = false;
    scene.add(holder);

    // Real glass refracts what is behind it, so a big object gets a backdrop
    // in the colour of whatever it sits on, exempt from tone mapping.
    let backdrop = null;
    if (big) {
      backdrop = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ toneMapped: false }));
      backdrop.position.z = -6;
      backdrop.visible = false;
      onlyInRefraction(backdrop);
      scene.add(backdrop);
    }

    objects.push({
      img, holder, pose, uniforms, drops, backdrop, big,
      phase: Math.random() * 6.28, hover: 0, spin: 0,
      set melt(v) { for (const u of uniforms) { u.uMelt.value = v; u.wet(v); } drops.uniforms.uMelt.value = v; },
      set mode(m) { for (const u of uniforms) u.uMode.value = m; drops.uniforms.uMode.value = m; },
    });
  }
  if (!objects.length) return;

  const paintBackdrops = () => {
    for (const o of objects) {
      if (!o.backdrop) continue;
      let el = o.img.parentElement, bg = "";
      while (el && (!bg || /rgba\(0, 0, 0, 0\)|transparent/.test(bg))) {
        bg = getComputedStyle(el).backgroundColor;
        el = el.parentElement;
      }
      o.backdrop.material.color.setStyle(bg || getComputedStyle(document.body).backgroundColor);
    }
  };

  document.body.append(canvas);
  paintBackdrops();
  new MutationObserver(() => requestAnimationFrame(paintBackdrops)).observe(document.documentElement, {
    attributes: true, attributeFilter: ["data-theme", "class"],
  });

  const size = () => renderer.setSize(innerWidth, innerHeight, false);
  size();
  addEventListener("resize", size);

  let mx = -1e4, my = -1e4;
  addEventListener("pointermove", (e) => { mx = e.clientX; my = e.clientY; }, { passive: true });

  // Arriving from another page: start melted, then reform.
  const a = arrival();
  if (a) {
    for (const o of objects) { o.mode = a.form; o.melt = 1; }
  }

  // Build every shader before anything is shown, in parallel where the
  // browser allows, so neither the first frame nor the reform stutters.
  for (const o of objects) { o.holder.visible = true; if (o.backdrop) o.backdrop.visible = true; }
  await renderer.compileAsync(scene, camera);
  for (const o of objects) { o.holder.visible = false; if (o.backdrop) o.backdrop.visible = false; }

  const clock = new THREE.Clock();
  let first = true;
  function frame() {
    const t = reduced ? 0 : clock.getElapsedTime();
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    for (const o of objects) {
      const r = o.img.getBoundingClientRect();
      if (r.width < 2 || r.bottom < -r.height || r.top > innerHeight + r.height || r.right < -r.width || r.left > innerWidth + r.width) continue;
      // Draw into a box a little larger than the image, so a tilted object
      // is never clipped at the image's edge.
      const pad = r.width * 0.25;
      const x = r.left - pad, y = innerHeight - r.bottom - pad, w = r.width + pad * 2, h = r.height + pad * 2;
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();

      const over = mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
      o.hover += ((over ? 1 : 0) - o.hover) * 0.08;
      o.spin += o.hover * 0.04;
      const px = over ? ((mx - r.left) / r.width - 0.5) : 0;
      const py = over ? ((my - r.top) / r.height - 0.5) : 0;
      o.holder.rotation.set(py * 0.5, Math.sin(t * 0.55 + o.phase) * 0.32 + o.spin + px * 0.6, 0);
      o.holder.position.y = Math.sin(t * 1.1 + o.phase) * 0.05;

      o.holder.visible = true;
      if (o.backdrop) o.backdrop.visible = true;
      renderer.render(scene, camera);
      o.holder.visible = false;
      if (o.backdrop) o.backdrop.visible = false;
    }
    if (first) {
      first = false;
      for (const o of objects) o.img.style.visibility = "hidden";
      document.documentElement.classList.remove("is-arriving");
      if (a && !reduced) shown().then(() => reform(a.form));
    }
  }
  renderer.setAnimationLoop(frame);

  async function reform(mode) {
    // Biggest first, the rest following a beat behind.
    const order = [...objects].sort((p, q) => q.img.getBoundingClientRect().width - p.img.getBoundingClientRect().width);
    await Promise.all(order.map((o, i) => {
      o.mode = mode;
      return new Promise((r) => setTimeout(r, i === 0 ? 120 : 260 + i * 60)).then(() =>
        tween(1, 0, o === order[0] ? 1500 : 1000, (v) => (o.melt = v), (x) => 1 - Math.pow(1 - x, 3)));
    }));
  }

  addEventListener("adeia:melt", (e) => {
    const { mode, ms } = e.detail;
    const order = [...objects].sort((p, q) => q.img.getBoundingClientRect().width - p.img.getBoundingClientRect().width);
    order.forEach((o, i) => {
      o.mode = mode;
      setTimeout(() => tween(0, 1, ms * (i === 0 ? 1 : 0.8), (v) => (o.melt = v), (x) => Math.pow(x, 1.15)), i === 0 ? 0 : 40 + i * 25);
    });
  });
  // Back/forward cache: a page restored mid-melt comes back whole.
  addEventListener("pageshow", (e) => { if (e.persisted) for (const o of objects) o.melt = 0; });
}

start().catch((err) => {
  console.warn("objects3d: keeping the stills", err);
  for (const img of imgs) img.style.visibility = "";
});
