/**
 * Adeia — the live wordmark on the landing desk.
 *
 * The word sits still at the centre; a chrome ring orbits it. The ring's
 * inner radius is wider than the word's bounding sphere, so no angle of
 * the orbit can cut through a letter — the old still render had the ring
 * slicing the "a".
 *
 * The <img> stays in the page as the poster: it is what shows before this
 * loads, without WebGL, and if anything here throws. It is hidden only
 * after the first frame has drawn.
 *
 * Word geometry comes from scripts/3d/adeia-3d.blend ("Wordmark"), packed
 * as: u32 vertexCount, u32 indexCount, int16 xyz (×2 scale), int8 xyz
 * normals padded to 4 bytes, uint16 indices.
 */

import * as THREE from "/vendor/three.module.min.js";
import { RoomEnvironment } from "/vendor/RoomEnvironment.js";

const poster = document.querySelector("img.desk__hero, img.dash-3d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Blender's "Sweep" ramp, linear RGB, left to right across the word. */
const RAMP = [
  [0.014, 0.06, 1.0],
  [0.102, 0.024, 1.0],
  [0.328, 0.006, 1.0],
];

/* Word bounding sphere is ~1.92; inner edge of the ring is RING_R - TUBE. */
const RING_R = 2.4;
const TUBE = 0.1;

async function loadWord() {
  const buf = await (await fetch("/3d/wordmark.bin")).arrayBuffer();
  const [nv, ni] = new Uint32Array(buf, 0, 2);
  let off = 8;
  const pos = new Int16Array(buf, off, nv * 3);
  off += nv * 6;
  const nor = new Int8Array(buf, off, nv * 3);
  off += nv * 3 + ((4 - ((nv * 3) % 4)) % 4);
  const idx = new Uint16Array(buf, off, ni);

  const col = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const t = Math.min(1, Math.max(0, (pos[i * 3] / 32767) * 2 / 3.55 + 0.5)) * 2;
    const a = RAMP[Math.min(1, Math.floor(t))];
    const b = RAMP[Math.min(2, Math.floor(t) + 1)];
    const f = t - Math.floor(t);
    for (let c = 0; c < 3; c++) col[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3, true));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3, true));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));

  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
    }),
  );
  mesh.scale.setScalar(2); // positions were stored divided by 2
  return mesh;
}

/**
 * Soft round points that drift around a circle in their own XY plane.
 * `place(i)` returns [angle, radius, z]; `spin` is radians per second.
 * Normal blending, not additive: the desk is light, and additive dots on
 * a light background vanish.
 */
function dust(count, place, spin) {
  const seed = new Float32Array(count * 3);
  const look = new Float32Array(count * 4); // size, phase, colour t, sparkle
  for (let i = 0; i < count; i++) {
    seed.set(place(i), i * 3);
    look.set([0.6 + Math.random() ** 3 * 2.6, Math.random() * 6.283, Math.random(), Math.random() < 0.12 ? 1 : 0], i * 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(seed, 3));
  g.setAttribute("aLook", new THREE.BufferAttribute(look, 4));
  const uniforms = {
    uTime: { value: 0 },
    uSpin: { value: spin },
    uPx: { value: Math.min(devicePixelRatio, 2) },
    uA: { value: new THREE.Color(...RAMP[0]) },
    uB: { value: new THREE.Color(...RAMP[2]) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute vec4 aLook;
      uniform float uTime, uSpin, uPx;
      varying float vT, vSpark, vTw;
      void main() {
        float a = position.x + uTime * uSpin * (0.7 + aLook.y * 0.08);
        float r = position.y + sin(uTime * 0.9 + aLook.y) * 0.04;
        vec3 p = vec3(cos(a) * r, sin(a) * r, position.z + sin(uTime * 0.6 + aLook.y * 2.0) * 0.05);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vT = aLook.z; vSpark = aLook.w;
        vTw = 0.55 + 0.45 * sin(uTime * (1.5 + aLook.y) + aLook.y * 9.0);
        gl_PointSize = aLook.x * uPx * (14.0 / -mv.z) * (1.0 + vSpark * 0.8);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uA, uB;
      varying float vT, vSpark, vTw;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float soft = smoothstep(0.5, 0.0, d);
        vec3 c = mix(mix(uA, uB, vT), vec3(1.0), vSpark * 0.85);
        gl_FragColor = vec4(c, soft * soft * (0.35 + 0.65 * vTw));
        #include <colorspace_fragment>
      }`,
  });
  return { points: new THREE.Points(g, material), uniforms };
}

async function start() {
  const canvas = document.createElement("canvas");
  canvas.className = poster.className;
  canvas.setAttribute("aria-hidden", "true");

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping; // Blender's default view transform

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(30, 1.8, 0.1, 100);
  camera.position.set(0, 1.1, 8.4);
  camera.lookAt(0, 0, 0);

  const rig = new THREE.Group(); // pointer parallax tilts word and ring together
  scene.add(rig);

  const word = await loadWord();
  rig.add(word);

  // Orbit: the pivot spins about the vertical, the ring rides it tilted,
  // so its near edge sweeps in front of the word and back behind it.
  const pivot = new THREE.Group();
  pivot.rotation.z = 0.32;
  rig.add(pivot);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(RING_R, TUBE, 48, 240),
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0.888, 0.888, 0.93),
      metalness: 1,
      roughness: 0.06,
      iridescence: 0.55,
      iridescenceIOR: 1.35,
    }),
  );
  pivot.add(ring);

  // Dust riding the ring's orbit, and a sparse halo around the whole thing.
  const trail = dust(2600, (i) => {
    const a = Math.random() * Math.PI * 2;
    const spread = (Math.random() ** 2) * 0.55;
    return [a, RING_R + (Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread * 0.6];
  }, 0.22);
  ring.add(trail.points);
  const halo = dust(700, () => {
    const a = Math.random() * Math.PI * 2;
    return [a, 2.9 + Math.random() * 2.2, (Math.random() - 0.5) * 3];
  }, 0.04);
  halo.points.rotation.x = Math.PI / 2;
  rig.add(halo.points);

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
    trail.uniforms.uTime.value = t;
    halo.uniforms.uTime.value = t;
    pivot.rotation.y = t * 0.55;
    ring.rotation.x = 1.15 + Math.sin(t * 0.4) * 0.12;
    word.rotation.y = Math.sin(t * 0.3) * 0.18;
    word.position.y = Math.sin(t * 0.8) * 0.06;
    px += (tx - px) * 0.05;
    py += (ty - py) * 0.05;
    rig.rotation.set(py * 0.12, px * 0.2, 0);
    renderer.render(scene, camera);
  }

  poster.after(canvas);
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
