/**
 * Adeia — what every live 3D object on the site shares: the studio light,
 * the procedural surface maps, the physical materials by role, and the
 * melt. hero3d.js (the wordmark) and objects3d.js (everything else) both
 * build on this, so a lock and the word are lit and made the same way.
 *
 * The melt is one vertex/fragment patch with four modes, played forward to
 * melt and backward to reform:
 *   0 drip       top-down, columns sag at different speeds and pool
 *   1 shatter    breaks into droplets that burst and fall
 *   2 evaporate  rises and thins into mist
 *   3 ripple     waves run through it, then it settles into a disc
 */

import * as THREE from "/vendor/three.module.min.js";
import { RoomEnvironment } from "/vendor/RoomEnvironment.js";
import { RGBELoader } from "/vendor/RGBELoader.js";

export { THREE };

/* ---------------------------------------------------------------- *
 * Light
 * ---------------------------------------------------------------- */

/** Procedural room now, the real studio HDRI when it lands. */
export function studio(renderer, scene, onSwap) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentRotation.set(0, 0.6, 0);
  new RGBELoader()
    .loadAsync("/3d/studio.hdr")
    .then((hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      scene.environment = pmrem.fromEquirectangular(hdr).texture;
      scene.environmentIntensity = 1.05;
      hdr.dispose();
      onSwap?.();
    })
    .catch(() => {});
}

/* ---------------------------------------------------------------- *
 * Procedural maps
 * ---------------------------------------------------------------- */

function canvasTexture(canvas, repeat = [1, 1]) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function heightToNormal(h, w, hh, strength) {
  const c = document.createElement("canvas");
  c.width = w; c.height = hh;
  const ctx = c.getContext("2d");
  const out = ctx.createImageData(w, hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const at = (xx, yy) => h[((yy + hh) % hh) * w + ((xx + w) % w)];
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength, dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
      out.data[i] = (-dx / l * 0.5 + 0.5) * 255;
      out.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function valueNoise(size, cells, octaves, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = cells << o;
    const lat = Float32Array.from({ length: n * n }, rnd);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = (x / size) * n, fy = (y / size) * n, x0 = fx | 0, y0 = fy | 0;
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i, j) => lat[(j % n) * n + (i % n)];
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      out[y * size + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    }
    total += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

let MAPS;
/** Built once per page, shared by every material. */
export function maps() {
  if (MAPS) return MAPS;
  const S = 256;
  const peel = valueNoise(S, 24, 3, 7);
  const smudge = valueNoise(S, 3, 4, 19);
  const gloss = document.createElement("canvas");
  gloss.width = gloss.height = S;
  const g = gloss.getContext("2d");
  const gi = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 150 + (smudge[i] - 0.5) * 140;
    gi.data[i * 4] = gi.data[i * 4 + 1] = gi.data[i * 4 + 2] = v; gi.data[i * 4 + 3] = 255;
  }
  g.putImageData(gi, 0, 0);
  g.globalAlpha = 0.18; g.strokeStyle = "#fff";
  for (const [cx, cy, r0] of [[70, 180, 34], [196, 60, 28]]) {
    for (let r = 4; r < r0; r += 3) { g.lineWidth = 1.1; g.beginPath(); g.ellipse(cx, cy, r * 1.25, r, 0.6, 0.3, Math.PI * 1.7); g.stroke(); }
  }
  // Flaws: shallow dents and hairline scratches.
  const f = document.createElement("canvas");
  f.width = f.height = S;
  const fc = f.getContext("2d");
  fc.fillStyle = "rgb(128,128,128)"; fc.fillRect(0, 0, S, S);
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 2 + Math.random() * 7;
    const gr = fc.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, "rgba(60,60,60,0.9)"); gr.addColorStop(1, "rgba(128,128,128,0)");
    fc.fillStyle = gr; fc.beginPath(); fc.arc(x, y, r, 0, Math.PI * 2); fc.fill();
  }
  fc.strokeStyle = "rgba(200,200,200,0.7)";
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S, y = Math.random() * S, a = Math.random() * Math.PI, l = 10 + Math.random() * 60;
    fc.lineWidth = 0.6; fc.beginPath(); fc.moveTo(x, y);
    fc.quadraticCurveTo(x + Math.cos(a + 0.3) * l * 0.5, y + Math.sin(a + 0.3) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    fc.stroke();
  }
  const fd = fc.getImageData(0, 0, S, S).data;
  const fh = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) fh[i] = fd[i * 4] / 255 + (peel[i] - 0.5) * 0.15;
  // Brushing: streaks along U with sparse scratches.
  const W = 1024, H = 64;
  const b = document.createElement("canvas");
  b.width = W; b.height = H;
  const bc = b.getContext("2d");
  bc.fillStyle = "rgb(70,70,70)"; bc.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    const y = Math.random() * H, v = 40 + Math.random() * 90;
    bc.strokeStyle = `rgba(${v},${v},${v},${0.25 + Math.random() * 0.35})`;
    bc.lineWidth = 0.4 + Math.random() * 0.8;
    const x = Math.random() * W;
    bc.beginPath(); bc.moveTo(x, y); bc.lineTo(x + 60 + Math.random() * 400, y + (Math.random() - 0.5) * 0.6); bc.stroke();
  }
  bc.strokeStyle = "rgba(200,200,200,0.5)";
  for (let i = 0; i < 70; i++) {
    const x = Math.random() * W, y = Math.random() * H, a = (Math.random() - 0.5) * 1.2, l = 4 + Math.random() * 22;
    bc.lineWidth = 0.5; bc.beginPath(); bc.moveTo(x, y); bc.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); bc.stroke();
  }
  const bd = bc.getImageData(0, 0, W, H).data;
  const bh = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) bh[i] = bd[i * 4] / 255;
  MAPS = {
    peel: canvasTexture(heightToNormal(peel, S, S, 3.2)),
    flaws: canvasTexture(heightToNormal(fh, S, S, 4)),
    gloss: canvasTexture(gloss),
    brushRough: canvasTexture(b, [6, 1]),
    brushNormal: canvasTexture(heightToNormal(bh, W, H, 1.5), [6, 1]),
  };
  return MAPS;
}

/* ---------------------------------------------------------------- *
 * Materials by role
 * ---------------------------------------------------------------- */

const lin = (r, g, b) => new THREE.Color(r, g, b);

/**
 * `big` objects get real transmission (refraction, depth tint); small ones
 * get an opaque stand-in with the same colour and coat, because a
 * transmission pass per icon would cost a full-screen render each.
 */
export function material(role, { big = false } = {}) {
  const m = maps();
  const coat = {
    clearcoat: 1, clearcoatRoughness: 0.05, clearcoatNormalMap: m.peel,
    clearcoatNormalScale: new THREE.Vector2(0.12, 0.12), clearcoatRoughnessMap: m.gloss,
  };
  const glass = (tint, attenuation, dist) =>
    big
      ? new THREE.MeshPhysicalMaterial({
          color: tint, transmission: 1, thickness: 0.8, ior: 1.5, dispersion: 0.4,
          attenuationColor: attenuation, attenuationDistance: dist,
          roughness: 0.06, roughnessMap: m.gloss, normalMap: m.flaws, normalScale: new THREE.Vector2(0.06, 0.06),
          iridescence: 0.18, iridescenceIOR: 1.32, iridescenceThicknessRange: [180, 520],
          envMapIntensity: 1.25, ...coat,
        })
      : new THREE.MeshPhysicalMaterial({
          color: attenuation, roughness: 0.16, roughnessMap: m.gloss, sheen: 0.4, sheenColor: tint,
          sheenRoughness: 0.4, iridescence: 0.25, iridescenceIOR: 1.32, envMapIntensity: 1.3, ...coat,
        });
  switch (role) {
    case "Amber":
      return glass(lin(0.5, 0.58, 1.0), lin(0.12, 0.2, 1.0), 1.1);
    case "Sweep":
      return glass(lin(0.55, 0.5, 1.0), lin(0.2, 0.1, 1.0), 1.1);
    case "Copper":
      return glass(lin(0.68, 0.48, 1.0), lin(0.45, 0.12, 1.0), 1.0);
    case "Rust":
      return glass(lin(1.0, 0.6, 0.8), lin(0.92, 0.2, 0.5), 0.9);
    case "Bone":
    case "Sand":
      return new THREE.MeshPhysicalMaterial({
        color: role === "Bone" ? lin(0.96, 0.96, 0.98) : lin(0.86, 0.84, 0.9),
        transmission: big ? 0.85 : 0, thickness: 0.6, roughness: 0.38, roughnessMap: m.gloss,
        sheen: 0.5, sheenRoughness: 0.6, sheenColor: lin(0.9, 0.9, 1.0), envMapIntensity: 1.1,
        ...coat, clearcoat: 0.7,
      });
    case "Steel":
    case "Chrome":
      return new THREE.MeshPhysicalMaterial({
        color: role === "Chrome" ? lin(0.93, 0.93, 0.96) : lin(0.62, 0.62, 0.66),
        metalness: 1, roughness: 0.2, roughnessMap: m.brushRough, normalMap: m.brushNormal,
        normalScale: new THREE.Vector2(0.18, 0.18), anisotropy: 0.8, clearcoat: 0.45, clearcoatRoughness: 0.04,
        iridescence: 0.18, iridescenceIOR: 1.4, envMapIntensity: 1.2,
      });
    default: // Ink, Graphite: smoked glass
      return big
        ? new THREE.MeshPhysicalMaterial({
            color: lin(0.5, 0.5, 0.56), transmission: 1, thickness: 0.8, ior: 1.5,
            attenuationColor: lin(0.05, 0.05, 0.08), attenuationDistance: 0.35, roughness: 0.05, envMapIntensity: 1.2, ...coat,
          })
        : new THREE.MeshPhysicalMaterial({ color: lin(0.02, 0.02, 0.03), roughness: 0.12, envMapIntensity: 1.4, ...coat });
  }
}

/* ---------------------------------------------------------------- *
 * The melt
 * ---------------------------------------------------------------- */

/* The melt is computed once per vertex, before normals, so the surface can
   turn toward the sky as it pools: a puddle catches the room's light the way
   water does, instead of keeping the shading of the shape it used to be.
   Nothing is cut away — the last of it shrinks and spreads to nothing. */
const MELT_HEAD = `
  uniform float uMelt, uMode, uFloor, uTop, uSeed;
  float meltK;
  vec3 meltOffset;
  float mh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719)) + uSeed) * 43758.5453); }
  float mn(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(mh(i), mh(i + vec3(1,0,0)), f.x), mix(mh(i + vec3(0,1,0)), mh(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(mh(i + vec3(0,0,1)), mh(i + vec3(1,0,1)), f.x), mix(mh(i + vec3(0,1,1)), mh(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  vec3 meltAt(vec3 p) {
    float hgt = clamp((p.y - uFloor) / max(uTop - uFloor, 1e-3), 0.0, 1.0);
    float nz = mn(p * 2.2);
    float m = uMelt;
    vec3 q = p;
    // How far along this vertex is: tops go first, with a wandering front.
    float k = smoothstep(0.0, 1.0, clamp(m * 1.6 - (1.0 - hgt) * 0.45 - nz * 0.3, 0.0, 1.0));
    vec2 out2 = normalize(p.xz + 1e-4);
    float pool = uFloor + 0.015;
    if (uMode < 0.5) {
      // Drip: slumps top-down; a few columns run ahead as drips, then pool.
      float drip = pow(mn(vec3(p.x * 5.0, 0.0, p.z * 5.0)), 4.0);
      q.y = mix(p.y, pool + (p.y - uFloor) * 0.03, k) - drip * sin(k * 3.14159) * 0.9;
      q.xz += out2 * k * k * (0.45 + nz * 0.35);
    } else if (uMode < 1.5) {
      // Splash: drops all at once and slaps out into a wide, thin sheet.
      float f = smoothstep(0.0, 1.0, clamp(m * 1.8 - nz * 0.25, 0.0, 1.0));
      q.y = mix(p.y, pool, f) + sin(f * 3.14159) * 0.12 * (1.0 - hgt);
      q.xz += out2 * f * (0.8 + nz * 0.6);
      k = f;
    } else if (uMode < 2.5) {
      // Thaw: softens and sags from the bottom up, sliding as it goes.
      float kk = smoothstep(0.0, 1.0, clamp(m * 1.6 - hgt * 0.5 - nz * 0.25, 0.0, 1.0));
      q.y = mix(p.y, pool + (p.y - uFloor) * 0.05, kk);
      q.x += sin(p.y * 4.0 + nz * 3.0) * 0.15 * sin(kk * 3.14159);
      q.xz += out2 * kk * 0.5;
      k = kk;
    } else {
      // Ripple: a wave runs through it before it settles into a disc.
      float r = length(p.xz);
      q.y += sin(r * 9.0 - m * 16.0) * 0.4 * k * (1.0 - k);
      q.y = mix(q.y, pool, smoothstep(0.4, 1.0, k));
      q.xz *= 1.0 + smoothstep(0.4, 1.0, k) * 0.55;
    }
    // The last of it spreads thin and is gone.
    float gone = smoothstep(0.82, 1.0, m);
    q.y = mix(q.y, pool, gone);
    q.xz *= 1.0 + gone * 0.4;
    q = mix(q, vec3(p.x, pool, p.z) * vec3(0.0, 1.0, 0.0), gone * gone);
    meltK = k;
    return q;
  }`;

const MELT_NORMAL = `
  vec3 objectNormal = vec3(normal);
  meltK = 0.0;
  meltOffset = position;
  if (uMelt > 0.0) {
    meltOffset = meltAt(position);
    objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), smoothstep(0.35, 0.9, meltK)));
  }
  #ifdef USE_TANGENT
    vec3 objectTangent = vec3(tangent.xyz);
  #endif`;

const MELT_BODY = `
  vec3 transformed = uMelt > 0.0 ? meltOffset : vec3(position);`;

/** Makes a material meltable; returns the uniforms to drive. */
export function meltable(mat, floor = -1, top = 1, seed = Math.random() * 100) {
  const u = {
    uMelt: { value: 0 }, uMode: { value: 0 }, uFloor: { value: floor }, uTop: { value: top }, uSeed: { value: seed },
  };
  // Wetter as it melts: the surface polishes toward water.
  const dry = { roughness: mat.roughness, clearcoatRoughness: mat.clearcoatRoughness ?? 0 };
  u.wet = (v) => {
    mat.roughness = dry.roughness * (1 - v * 0.85);
    if ("clearcoatRoughness" in mat) mat.clearcoatRoughness = dry.clearcoatRoughness * (1 - v);
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = MELT_HEAD + "\n" + shader.vertexShader
      .replace("#include <beginnormal_vertex>", MELT_NORMAL)
      .replace("#include <begin_vertex>", MELT_BODY);
  };
  mat.customProgramCacheKey = () => "melt2";
  return u;
}

/* ---------------------------------------------------------------- *
 * Water: droplets shed while melting, gathered while reforming
 * ---------------------------------------------------------------- */

export function droplets(count, box) {
  const seed = new Float32Array(count * 4); // start xyz (on the object), random
  for (let i = 0; i < count; i++) {
    seed.set([
      box.min.x + Math.random() * (box.max.x - box.min.x),
      box.min.y + Math.random() * (box.max.y - box.min.y),
      box.min.z + Math.random() * (box.max.z - box.min.z),
      Math.random(),
    ], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  const uniforms = { uMelt: { value: 0 }, uMode: { value: 0 }, uFloor: { value: box.min.y }, uPx: { value: Math.min(devicePixelRatio, 2) }, uScale: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: `
      attribute vec4 aSeed;
      uniform float uMelt, uMode, uFloor, uPx, uScale;
      varying float vA;
      void main() {
        float r = aSeed.w;
        float t = clamp(uMelt * 1.5 - r * 0.5, 0.0, 1.0);
        vec3 p = aSeed.xyz;
        vec3 dir = normalize(vec3(fract(r * 91.7) - 0.5, fract(r * 37.3), fract(r * 13.1) - 0.5));
        if (uMode < 0.5)      p = vec3(p.x + dir.x * t * 0.3, mix(p.y, uFloor, t * t), p.z + dir.z * t * 0.3);
        else if (uMode < 1.5) p += dir * t * 1.6 - vec3(0.0, t * t * 2.2, 0.0);
        else if (uMode < 2.5) p = vec3(p.x + dir.x * t * 0.2, mix(p.y, uFloor, smoothstep(0.0, 1.0, t)), p.z + dir.z * t * 0.2);
        else                  p = vec3(p.x * (1.0 + t * 0.6), mix(p.y, uFloor, t), p.z * (1.0 + t * 0.6));
        vA = sin(t * 3.14159) * 0.9;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (2.0 + fract(r * 53.0) * 5.0) * uPx * uScale * (6.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float d = length(q);
        if (d > 0.5) discard;
        // A water bead: clear body, darker rim, one bright highlight.
        float rim = smoothstep(0.32, 0.5, d);
        float spec = exp(-dot(q - vec2(-0.14, -0.14), q - vec2(-0.14, -0.14)) * 160.0);
        vec3 c = mix(vec3(0.72, 0.8, 1.0), vec3(0.2, 0.28, 0.6), rim) + spec;
        gl_FragColor = vec4(c, vA * (0.35 + rim * 0.5 + spec));
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  return { points, uniforms };
}

/* ---------------------------------------------------------------- *
 * Timing
 * ---------------------------------------------------------------- */

/** Animates `set(v)` from a to b; resolves when done. */
export function tween(a, b, ms, set, ease = (x) => x * x * (3 - 2 * x)) {
  return new Promise((done) => {
    const t0 = performance.now();
    const step = (now) => {
      const x = Math.min(1, (now - t0) / ms);
      set(a + (b - a) * ease(x));
      if (x < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
}

/**
 * Whether this page was reached by moving within the site, and which reform
 * it plays. Worked out from the page itself rather than handed over, because
 * a prerendered page loads before the click that will show it.
 */
export function arrival() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  let ref;
  try { ref = new URL(document.referrer); } catch { return null; }
  if (ref.origin !== location.origin || ref.href === location.href) return null;
  const nav = performance.getEntriesByType("navigation")[0];
  if (nav && nav.type === "reload") return null;
  return { form: (hashPath(location.pathname + location.search) >>> 2) % 4 };
}

export const hashPath = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;

/** Resolves once the page is actually on screen (immediately unless prerendered). */
export const shown = () =>
  document.prerendering ? new Promise((r) => document.addEventListener("prerenderingchange", r, { once: true })) : Promise.resolve();
