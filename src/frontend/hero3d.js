/**
 * Adeia — the live wordmark on the landing desk and the dashboard.
 *
 * The word sits still at the centre; a brushed-chrome ring orbits it. The
 * ring's inner radius is wider than the word's bounding sphere, so no angle
 * of the orbit can cut through a letter.
 *
 * Realism comes from three places, cheapest first:
 *   1. Light. A real studio HDRI (Poly Haven "Studio Small 08", CC0, cut to
 *      512×256) lights and reflects everything. Until it arrives, a
 *      procedural room stands in, so the first frame never waits on it.
 *   2. Surface. Procedural maps, generated here rather than downloaded:
 *      orange-peel in the word's clear coat, faint smudges in its gloss,
 *      a thin-film shimmer; machining streaks and stray scratches on the
 *      ring, with anisotropic highlights that stretch along the brushing.
 *   3. Particles with optics. Dust orbits with the ring, a wider field
 *      drifts around it, and a few large motes sit near the lens. Each
 *      point is sized by its distance from the focal plane, so out-of-focus
 *      ones open into bokeh discs with a bright rim and a slight colour
 *      fringe; a few sparkle with a four-point flare.
 *
 * The <img> stays in the page as the poster: it is what shows before this
 * loads, without WebGL, and if anything here throws.
 *
 * Word geometry comes from scripts/3d/export-wordmark.py, packed as:
 * u32 vertexCount, u32 indexCount, int16 xyz (×2 scale), int8 xyz normals
 * padded to 4 bytes, uint16 indices.
 */

import * as THREE from "/vendor/three.module.min.js";
import { RoomEnvironment } from "/vendor/RoomEnvironment.js";
import { RGBELoader } from "/vendor/RGBELoader.js";

const poster = document.querySelector("img.desk__hero, img.dash-3d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = matchMedia("(max-width: 860px)").matches;

/* Blender's "Sweep" ramp, linear RGB, left to right across the word. */
const RAMP = [
  [0.014, 0.06, 1.0],
  [0.102, 0.024, 1.0],
  [0.328, 0.006, 1.0],
];

/* Word bounding sphere is ~1.92; inner edge of the ring is RING_R - TUBE. */
const RING_R = 2.4;
const TUBE = 0.105;
const FOCUS = 8.6; // camera-to-word distance: the plane that stays sharp

/* ---------------------------------------------------------------- *
 * Procedural textures
 * ---------------------------------------------------------------- */

/** Tileable value noise, a few octaves, in [0,1]. */
function noiseField(size, cells, octaves, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = cells << o;
    const lattice = Float32Array.from({ length: n * n }, rnd);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * n, fy = (y / size) * n;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const at = (i, j) => lattice[((j % n) * n) + (i % n)];
        const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
        out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function toTexture(size, pixel, { repeat = [1, 1], color = false } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const [r, g, b] = pixel(i);
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finishTexture(c, repeat, color);
}

function finishTexture(canvas, repeat, color) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

/** Height field to tangent-space normal map. */
function normalMapFrom(height, size, strength, repeat) {
  return toTexture(size, (i) => {
    const x = i % size, y = (i / size) | 0;
    const h = (xx, yy) => height[((yy + size) % size) * size + ((xx + size) % size)];
    const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
    const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  }, { repeat });
}

/** Lacquer: fine orange-peel in the coat, broad soft smudges in the gloss. */
function lacquerMaps() {
  const S = 256;
  const peel = noiseField(S, 24, 3, 7);
  const smudge = noiseField(S, 3, 4, 19);
  const prints = document.createElement("canvas");
  prints.width = prints.height = S;
  const p = prints.getContext("2d");
  const img = p.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 150 + (smudge[i] - 0.5) * 140;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  p.putImageData(img, 0, 0);
  // A couple of faint fingerprints: concentric arcs, the way a real glossy
  // object picks them up where it was last handled.
  p.globalAlpha = 0.18;
  p.strokeStyle = "#ffffff";
  for (const [cx, cy, r0] of [[70, 180, 34], [196, 60, 28]]) {
    for (let r = 4; r < r0; r += 3) {
      p.lineWidth = 1.1;
      p.beginPath();
      p.ellipse(cx, cy, r * 1.25, r, 0.6, 0.3, Math.PI * 1.7);
      p.stroke();
    }
  }
  // Flaws: a few shallow dents and hairline scratches, the kind a real
  // glass object collects. Drawn as a height field, then turned into normals.
  const f = document.createElement("canvas");
  f.width = f.height = S;
  const fc = f.getContext("2d");
  fc.fillStyle = "rgb(128,128,128)";
  fc.fillRect(0, 0, S, S);
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 2 + Math.random() * 7;
    const g = fc.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(60,60,60,0.9)");
    g.addColorStop(1, "rgba(128,128,128,0)");
    fc.fillStyle = g;
    fc.beginPath(); fc.arc(x, y, r, 0, Math.PI * 2); fc.fill();
  }
  fc.strokeStyle = "rgba(200,200,200,0.7)";
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S, y = Math.random() * S, a = Math.random() * Math.PI, l = 10 + Math.random() * 60;
    fc.lineWidth = 0.6;
    fc.beginPath(); fc.moveTo(x, y); fc.quadraticCurveTo(x + Math.cos(a + 0.3) * l * 0.5, y + Math.sin(a + 0.3) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); fc.stroke();
  }
  const fd = fc.getImageData(0, 0, S, S).data;
  const fh = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) fh[i] = fd[i * 4] / 255 + (peel[i] - 0.5) * 0.15;
  return {
    peel: normalMapFrom(peel, S, 3.2, [1, 1]),
    flaws: normalMapFrom(fh, S, 4, [1, 1]),
    gloss: finishTexture(prints, [1, 1], false),
  };
}

/** Machined metal: streaks along the ring, plus sparse fine scratches. */
function brushedMaps() {
  const W = 1024, H = 64;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgb(70,70,70)";
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    const y = Math.random() * H;
    const v = 40 + Math.random() * 90;
    ctx.strokeStyle = `rgba(${v},${v},${v},${0.25 + Math.random() * 0.35})`;
    ctx.lineWidth = 0.4 + Math.random() * 0.8;
    const x = Math.random() * W;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 60 + Math.random() * 400, y + (Math.random() - 0.5) * 0.6); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(200,200,200,0.5)";
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * W, y = Math.random() * H, a = (Math.random() - 0.5) * 1.2, l = 4 + Math.random() * 22;
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
  }
  const rough = finishTexture(c, [6, 1], false);
  const g = ctx.getImageData(0, 0, W, H).data;
  const height = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) height[i] = g[i * 4] / 255;
  // A non-square height field: build the normal map at its own size.
  const n = document.createElement("canvas");
  n.width = W; n.height = H;
  const nc = n.getContext("2d");
  const out = nc.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const h = (xx, yy) => height[((yy + H) % H) * W + ((xx + W) % W)];
      const dx = (h(x + 1, y) - h(x - 1, y)) * 1.5, dy = (h(x, y + 1) - h(x, y - 1)) * 1.5;
      const l = Math.hypot(dx, dy, 1), i = (y * W + x) * 4;
      out.data[i] = (-dx / l * 0.5 + 0.5) * 255;
      out.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  nc.putImageData(out, 0, 0);
  return { rough, normal: finishTexture(n, [6, 1], false) };
}

/** A soft radial blot, for the contact shadow. */
function blot() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return finishTexture(c, [1, 1], false);
}

/* ---------------------------------------------------------------- *
 * The word
 * ---------------------------------------------------------------- */

async function loadWord(maps) {
  const buf = await (await fetch("/3d/wordmark.bin")).arrayBuffer();
  const [nv, ni] = new Uint32Array(buf, 0, 2);
  let off = 8;
  const pos = new Int16Array(buf, off, nv * 3);
  off += nv * 6;
  const nor = new Int8Array(buf, off, nv * 3);
  off += nv * 3 + ((4 - ((nv * 3) % 4)) % 4);
  const idx = new Uint16Array(buf, off, ni);

  const col = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) {
    const x = (pos[i * 3] / 32767) * 2, y = (pos[i * 3 + 1] / 32767) * 2, z = (pos[i * 3 + 2] / 32767) * 2;
    const t = Math.min(1, Math.max(0, x / 3.55 + 0.5)) * 2;
    const a = RAMP[Math.min(1, Math.floor(t))];
    const b = RAMP[Math.min(2, Math.floor(t) + 1)];
    const f = t - Math.floor(t);
    // Lifted toward white: glass tints what passes through, so a pure
    // saturated tint would read as ink rather than colour.
    for (let c = 0; c < 3; c++) col[i * 3 + c] = 0.24 + 0.76 * (a[c] + (b[c] - a[c]) * f);
    // Box projection: the geometry has no UVs, and noise does not need good ones.
    const ax = Math.abs(nor[i * 3]), ay = Math.abs(nor[i * 3 + 1]), az = Math.abs(nor[i * 3 + 2]);
    const [u, v] = az >= ax && az >= ay ? [x, y] : ax >= ay ? [z, y] : [x, z];
    uv[i * 2] = u * 0.55;
    uv[i * 2 + 1] = v * 0.55;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3, true));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3, true));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));

  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshPhysicalMaterial({
      // Coloured glass, not paint: light goes in, bends, picks up colour
      // the deeper it travels, and comes out split at the edges. The vertex
      // colours tint it blue to violet across the word.
      vertexColors: true,
      transmission: 1,
      thickness: 0.8,
      attenuationColor: new THREE.Color(0.42, 0.34, 1.0),
      attenuationDistance: 1.5,
      ior: 1.5,
      dispersion: 0.4,
      roughness: 0.06,
      roughnessMap: maps.gloss,
      normalMap: maps.flaws,
      normalScale: new THREE.Vector2(0.06, 0.06),
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      clearcoatRoughnessMap: maps.gloss,
      clearcoatNormalMap: maps.peel,
      clearcoatNormalScale: new THREE.Vector2(0.12, 0.12),
      iridescence: 0.18,
      iridescenceIOR: 1.32,
      iridescenceThicknessRange: [180, 520],
      specularIntensity: 1,
      envMapIntensity: 1.25,
    }),
  );
  mesh.scale.setScalar(2); // positions were stored divided by 2
  return mesh;
}

/* ---------------------------------------------------------------- *
 * Particles with optics
 * ---------------------------------------------------------------- */

const POINT_VERT = `
  attribute vec4 aLook;   // size, phase, colour t, sparkle
  uniform float uTime, uSpin, uPx, uFocus, uAperture, uDrift;
  varying float vT, vSpark, vTw, vBlur, vFade;
  void main() {
    float ph = aLook.y;
    float a = position.x + uTime * uSpin * (0.75 + fract(ph * 7.31) * 0.5);
    float r = position.y + sin(uTime * 0.7 + ph * 3.0) * 0.05 * uDrift;
    vec3 p = vec3(cos(a) * r, sin(a) * r, position.z + sin(uTime * 0.5 + ph * 5.0) * 0.08 * uDrift);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float coc = abs(-mv.z - uFocus) * uAperture;          // circle of confusion
    vBlur = clamp(coc, 0.0, 1.0);
    vT = aLook.z;
    vSpark = aLook.w;
    vTw = 0.5 + 0.5 * sin(uTime * (1.3 + fract(ph * 3.7) * 2.0) + ph * 11.0);
    vFade = 1.0 / (1.0 + coc * coc * 14.0);                // spread light over a bigger disc
    gl_PointSize = min(aLook.x * uPx * (16.0 / -mv.z) * (1.0 + coc * 3.5) * (1.0 + vSpark * 2.2), 48.0 * uPx);
    gl_Position = projectionMatrix * mv;
  }`;

const POINT_FRAG = `
  uniform vec3 uA, uB, uC;
  varying float vT, vSpark, vTw, vBlur, vFade;
  float disc(float d, float blur) {
    // In focus: a soft gaussian dot. Out of focus: a flat disc with a
    // brighter rim, which is what a real lens does to a point of light.
    float dot = exp(-d * d * 28.0);
    float edge = smoothstep(0.5, 0.44, d);
    float bokeh = edge * (0.55 + 0.45 * smoothstep(0.28, 0.47, d));
    return mix(dot, bokeh, smoothstep(0.15, 0.6, blur));
  }
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    float d = length(q);
    vec3 tint = vT < 0.5 ? mix(uA, uB, vT * 2.0) : mix(uB, uC, vT * 2.0 - 1.0);
    // A slight colour fringe: red sits a hair inside, blue a hair outside.
    float fr = disc(d * 1.04, vBlur), fg = disc(d, vBlur), fb = disc(d * 0.95, vBlur);
    vec3 col = tint * vec3(fr, fg, fb);
    float alpha = max(fr, max(fg, fb));
    if (vSpark > 0.5) {
      // Four-point flare, slowly breathing.
      float rays = exp(-abs(q.x) * 90.0) * exp(-abs(q.y) * 7.0) + exp(-abs(q.y) * 90.0) * exp(-abs(q.x) * 7.0);
      float core = exp(-d * d * 220.0);
      float flare = (rays * 0.9 + core) * (0.4 + 0.6 * vTw);
      col = mix(col, vec3(1.0), clamp(core * 1.5, 0.0, 1.0)) + tint * rays * 0.6;
      alpha = max(alpha * 0.5, flare);
    }
    alpha *= vFade * (0.45 + 0.55 * vTw);
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }`;

/**
 * A family of points drifting around a circle in their own XY plane.
 * `place()` returns [angle, radius, z]; `spin` is radians per second.
 * Normal blending, not additive: the desk is light, and additive points
 * on a light background vanish.
 */
function dust(count, place, { spin, size, sparkle = 0, aperture = 0.12, drift = 1 }) {
  const seed = new Float32Array(count * 3);
  const look = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seed.set(place(), i * 3);
    look.set([size(), Math.random() * 6.283, Math.random(), Math.random() < sparkle ? 1 : 0], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(seed, 3));
  g.setAttribute("aLook", new THREE.BufferAttribute(look, 4));
  const uniforms = {
    uTime: { value: 0 },
    uSpin: { value: spin },
    uPx: { value: Math.min(devicePixelRatio, 2) },
    uFocus: { value: FOCUS },
    uAperture: { value: aperture },
    uDrift: { value: drift },
    uA: { value: new THREE.Color(0.02, 0.12, 1.0) },
    uB: { value: new THREE.Color(0.2, 0.05, 1.0) },
    uC: { value: new THREE.Color(0.55, 0.2, 1.0) },
  };
  const points = new THREE.Points(
    g,
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
    }),
  );
  points.frustumCulled = false;
  return { points, uniforms };
}

const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

/* ---------------------------------------------------------------- *
 * Scene
 * ---------------------------------------------------------------- */

async function start() {
  const canvas = document.createElement("canvas");
  canvas.className = poster.className;
  canvas.setAttribute("aria-hidden", "true");

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping; // Blender's default view transform
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentRotation.set(0, 0.6, 0);

  // The real studio, swapped in when it arrives. The first frame never waits.
  new RGBELoader().loadAsync("/3d/studio.hdr").then((hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const env = pmrem.fromEquirectangular(hdr).texture;
    hdr.dispose();
    scene.environment = env;
    scene.environmentIntensity = 1.05;
    if (reduced) frame(2.2);
  }).catch(() => {});

  const camera = new THREE.PerspectiveCamera(30, 1.8, 0.1, 100);
  camera.position.set(0, 1.1, FOCUS);
  camera.lookAt(0, 0, 0);

  const rig = new THREE.Group(); // pointer parallax tilts everything together
  scene.add(rig);

  // Glass refracts what is rendered behind it, and a transparent canvas has
  // nothing there. So a plane far back carries the page's own background
  // colour, exempt from tone mapping so it matches the page exactly, and
  // follows the light/dark switch.
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 50),
    new THREE.MeshBasicMaterial({ toneMapped: false }),
  );
  backdrop.position.z = -7;
  scene.add(backdrop);
  const paintBackdrop = () => {
    const bg = getComputedStyle(canvas.parentElement || document.body).backgroundColor;
    const from = bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? bg : getComputedStyle(document.body).backgroundColor;
    backdrop.material.color.setStyle(from);
    if (reduced) frame(2.2);
  };
  new MutationObserver(() => requestAnimationFrame(paintBackdrop)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class"],
  });

  const word = await loadWord(lacquerMaps());
  rig.add(word);

  // Orbit: the pivot spins about the vertical, the ring rides it tilted,
  // so its near edge sweeps in front of the word and back behind it.
  const pivot = new THREE.Group();
  pivot.rotation.z = 0.32;
  rig.add(pivot);
  const brushed = brushedMaps();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(RING_R, TUBE, 64, 360),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0.93, 0.93, 0.96),
      metalness: 1,
      roughness: 0.2,
      roughnessMap: brushed.rough,
      normalMap: brushed.normal,
      normalScale: new THREE.Vector2(0.18, 0.18),
      anisotropy: 0.8,
      clearcoat: 0.5,
      clearcoatRoughness: 0.04,
      iridescence: 0.22,
      iridescenceIOR: 1.4,
      envMapIntensity: 1.2,
    }),
  );
  pivot.add(ring);

  // Contact shadow: grounds the piece without a shadow-casting light.
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 7),
    new THREE.MeshBasicMaterial({ map: blot(), color: 0x1a1240, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -1.95;
  shadow.scale.set(1, 0.45, 1);
  rig.add(shadow);

  const n = small ? 0.5 : 1; // half the points on a phone

  // 1. Dust riding the ring: dense at the tube, thinning out in a gaussian.
  const trail = dust(Math.round(5200 * n), () => {
    const a = Math.random() * Math.PI * 2;
    return [a, RING_R + gauss() * 0.28, gauss() * 0.16];
  }, { spin: 0.24, size: () => 0.35 + Math.random() ** 4 * 2.2, sparkle: 0.02, aperture: 0.035 });
  ring.add(trail.points);

  // 2. A second, looser band trailing behind it, slower.
  const wake = dust(Math.round(1600 * n), () => {
    const a = Math.random() * Math.PI * 2;
    return [a, RING_R + 0.25 + Math.random() * 0.7, gauss() * 0.45];
  }, { spin: 0.12, size: () => 0.4 + Math.random() ** 3 * 1.6, sparkle: 0.03, aperture: 0.045 });
  ring.add(wake.points);

  // 3. The field: a shell around the whole piece, some of it near the lens.
  const field = dust(Math.round(650 * n), () => {
    const a = Math.random() * Math.PI * 2;
    return [a, 2.9 + Math.random() * 2.4, gauss() * 1.6];
  }, { spin: 0.035, size: () => 0.4 + Math.random() ** 3 * 1.6, sparkle: 0.06, aperture: 0.05 });
  field.points.rotation.x = Math.PI / 2;
  rig.add(field.points);

  // 4. A handful of large motes almost at the lens: the deepest bokeh.
  const near = dust(9, () => {
    const a = Math.random() * Math.PI * 2;
    return [a, 2.2 + Math.random() * 2.2, 3.6 + Math.random() * 1.6];
  }, { spin: 0.02, size: () => 0.8 + Math.random() * 0.8, aperture: 0.09, drift: 2 });
  scene.add(near.points);

  const families = [trail, wake, field, near];

  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  let px = 0, py = 0, tx = 0, ty = 0;
  addEventListener("pointermove", (e) => {
    tx = (e.clientX / innerWidth) * 2 - 1;
    ty = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  const clock = new THREE.Clock();
  function frame(t) {
    for (const f of families) f.uniforms.uTime.value = t;
    pivot.rotation.y = t * 0.55;
    ring.rotation.x = 1.15 + Math.sin(t * 0.4) * 0.12;
    word.rotation.y = Math.sin(t * 0.3) * 0.18;
    word.position.y = Math.sin(t * 0.8) * 0.06;
    shadow.material.opacity = 0.2 - word.position.y * 0.6;
    px += (tx - px) * 0.05;
    py += (ty - py) * 0.05;
    rig.rotation.set(py * 0.12, px * 0.2, 0);
    // The light turns a little with the pointer, so highlights slide across
    // the lacquer the way they do when you tilt a real object.
    scene.environmentRotation.y = 0.6 + px * 0.35 + t * 0.02;
    renderer.render(scene, camera);
  }

  poster.after(canvas);
  paintBackdrop();
  new ResizeObserver(resize).observe(canvas);
  resize();
  frame(2.2); // a good opening angle, and the only one under reduced motion
  poster.style.display = "none";
  dispatchEvent(new Event("adeia:hero-ready"));

  if (!reduced) renderer.setAnimationLoop(() => frame(2.2 + clock.getElapsedTime()));
}

if (poster) {
  start().catch((err) => {
    console.warn("hero3d: keeping the still", err);
    dispatchEvent(new Event("adeia:hero-ready")); // the boot screen waits on this
  });
}
