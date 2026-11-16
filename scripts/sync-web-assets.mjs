import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Copies the design tokens into the Next.js app's public directory.
 *
 * `dashboard/page.ts` does `@import url("/styles/tokens.css")` so that the
 * dashboard cannot drift from the rest of Adeia — one file decides every
 * ground, mark and ink, and a contrast ratio verified once stays verified.
 * That worked when one process served both the marketing pages and the
 * dashboard. It no longer does: the ten static pages are on a CDN and the
 * deployed function never sees a request for a stylesheet.
 *
 * So the file is copied rather than duplicated. `src/frontend/styles/tokens.css`
 * stays the only version anybody edits; this runs before `next dev` and
 * `next build`, and the copy under `public/` is generated and gitignored.
 *
 * The alternative — pointing the import at https://adeia.xyz — would make the
 * dashboard's appearance depend on a second origin being up, and would render
 * it unstyled while developing offline.
 */

const root = new URL("../", import.meta.url);

/* tokens.css declares its @font-face rules with `url("../fonts/…")`, so the
   fonts have to sit beside the stylesheet in the same shape or the dashboard
   renders in whatever the browser falls back to. Copied for the same reason:
   one source, and this is a build step rather than a second copy to maintain. */
const ASSETS = [
  ["src/frontend/styles/tokens.css", "src/web/public/styles/tokens.css"],
  ...readdirSync(new URL("src/frontend/fonts/", root))
    .filter((name) => name.endsWith(".woff2"))
    .map((name) => [`src/frontend/fonts/${name}`, `src/web/public/fonts/${name}`]),

  /* The pointer choreography, shared with the marketing site rather than
     rewritten for the dashboard. cursor.js subscribes every effect to one
     rAF loop and does nothing at all under `prefers-reduced-motion` or on a
     device without hover, so the dashboard inherits that judgement instead
     of making its own. reveal.js needs the Motion library; cursor.js has no
     dependencies. Both are enhancement — the page is complete without them. */
  ["src/frontend/styles/cursor.css", "src/web/public/styles/cursor.css"],
  ["src/frontend/cursor.js", "src/web/public/cursor.js"],
  ["src/frontend/reveal.js", "src/web/public/reveal.js"],
  ["src/frontend/vendor/motion.js", "src/web/public/vendor/motion.js"],
  ["src/frontend/fence.js", "src/web/public/fence.js"],
  ["src/frontend/favicon.svg", "src/web/public/favicon.svg"],

  /* The desktop shell (menubar, notch, Explore island, windows, theme) and
     the Blender renders it shows, so the dashboard sits on the same desk
     as the marketing pages. */
  ["src/frontend/styles/os.css", "src/web/public/styles/os.css"],
  ["src/frontend/os.js", "src/web/public/os.js"],
  /* The live wordmark: the landing desk and the dashboard draw the same one. */
  ["src/frontend/hero3d.js", "src/web/public/hero3d.js"],
  ["src/frontend/boot.js", "src/web/public/boot.js"],
  ["src/frontend/vendor/three.module.min.js", "src/web/public/vendor/three.module.min.js"],
  ["src/frontend/vendor/RoomEnvironment.js", "src/web/public/vendor/RoomEnvironment.js"],
  ["src/frontend/vendor/RGBELoader.js", "src/web/public/vendor/RGBELoader.js"],
  ...readdirSync(new URL("src/frontend/3d/", root))
    .filter((name) => /\.(webp|bin|hdr)$/.test(name))
    .map((name) => [`src/frontend/3d/${name}`, `src/web/public/3d/${name}`]),
];

for (const [source, target] of ASSETS) {
  const to = fileURLToPath(new URL(target, root));
  mkdirSync(to.slice(0, to.lastIndexOf("/")), { recursive: true });
  copyFileSync(fileURLToPath(new URL(source, root)), to);
}

console.log(`[adeia] synced ${ASSETS.length} assets into src/web/public/`);
