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

const MELT_HEAD = `
  uniform float uMelt, uMode, uFloor, uTop, uSeed;
  varying vec3 vMeltPos;
  float mh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719)) + uSeed) * 43758.5453); }
  float mn(vec3 p) {
    vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(mh(i), mh(i + vec3(1,0,0)), f.x), mix(mh(i + vec3(0,1,0)), mh(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(mh(i + vec3(0,0,1)), mh(i + vec3(1,0,1)), f.x), mix(mh(i + vec3(0,1,1)), mh(i + vec3(1,1,1)), f.x), f.y), f.z);
  }`;

const MELT_BODY = `
  vec3 transformed = vec3(position);
  vMeltPos = position;
  if (uMelt > 0.0) {
    float hgt = clamp((position.y - uFloor) / max(uTop - uFloor, 1e-3), 0.0, 1.0);
    float nz = mn(position * 2.5);
    float m = uMelt;
    if (uMode < 0.5) {
      float k = smoothstep(0.0, 1.0, clamp(m * 1.7 - (1.0 - hgt) * 0.5 - nz * 0.35, 0.0, 1.0));
      float drip = pow(mn(vec3(position.x * 6.0, 0.0, position.z * 6.0)), 3.0) * 0.7;
      transformed.y = mix(position.y, uFloor + 0.02 + (position.y - uFloor) * 0.04, k) - drip * k * (1.0 - k) * 2.2;
      transformed.xz += normalize(position.xz + 1e-4) * k * k * (0.35 + nz * 0.3);
    } else if (uMode < 1.5) {
      float k = clamp(m * 1.4 - nz * 0.4, 0.0, 1.0);
      vec3 cell = floor(position * 8.0);
      vec3 dir = normalize(normal + vec3(mh(cell), mh(cell + 3.1), mh(cell + 7.7)) - 0.5);
      transformed += dir * k * 1.2;
      transformed.y -= k * k * 1.8;
      transformed *= 1.0 - k * 0.35;
    } else if (uMode < 2.5) {
      float k = clamp(m * 1.5 - hgt * 0.4 - nz * 0.3, 0.0, 1.0);
      transformed.y += k * k * 1.4 + sin(position.x * 5.0 + k * 6.0) * 0.08 * k;
      transformed.xz += (vec2(mn(position * 3.0 + 1.0), mn(position * 3.0 + 5.0)) - 0.5) * k * 0.8;
    } else {
      float r = length(position.xz);
      float k = clamp(m * 1.3, 0.0, 1.0);
      transformed.y += sin(r * 9.0 - m * 18.0) * 0.5 * k * (1.0 - k);
      float settle = smoothstep(0.45, 1.0, k);
      transformed.y = mix(transformed.y, uFloor + 0.02, settle);
      transformed.xz *= 1.0 + settle * 0.5;
    }
  }`;

const MELT_FRAG_HEAD = `
  uniform float uMelt, uMode, uSeed;
  varying vec3 vMeltPos;
  float fh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719)) + uSeed) * 43758.5453); }`;

const MELT_FRAG = `
  if (uMelt > 0.0) {
    // Shatter and evaporate thin out as they go; everything is gone at the end.
    float grain = fh(floor(vMeltPos * 40.0));
    float thin = (uMode > 0.5 && uMode < 2.5) ? uMelt * 0.9 : smoothstep(0.75, 1.0, uMelt);
    if (grain < thin) discard;
  }`;

/** Makes a material meltable; returns the uniforms to drive. */
export function meltable(mat, floor = -1, top = 1, seed = Math.random() * 100) {
  const u = {
    uMelt: { value: 0 }, uMode: { value: 0 }, uFloor: { value: floor }, uTop: { value: top }, uSeed: { value: seed },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = MELT_HEAD + "\n" + shader.vertexShader.replace("#include <begin_vertex>", MELT_BODY);
    shader.fragmentShader = MELT_FRAG_HEAD + "\n" + shader.fragmentShader.replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n" + MELT_FRAG);
  };
  mat.customProgramCacheKey = () => "melt";
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
        else if (uMode < 2.5) p += vec3(dir.x * 0.5, 1.0, dir.z * 0.5) * t * 1.8;
        else                  p = vec3(p.x * (1.0 + t * 0.6), mix(p.y, uFloor, t), p.z * (1.0 + t * 0.6));
        vA = sin(t * 3.14159) * (uMode > 1.5 && uMode < 2.5 ? 0.5 : 0.9);
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

/** What the page that sent us here asked for: {melt, form} modes, or null. */
export function arrival() {
  try {
    const raw = sessionStorage.getItem("adeia-arrive");
    if (!raw) return null;
    const a = JSON.parse(raw);
    return Date.now() - a.at < 8000 ? a : null;
  } catch {
    return null;
  }
}
