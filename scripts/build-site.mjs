/**
 * Cache-busts the landing page's local assets.
 *
 * Rewrites the `?v=` on every same-origin stylesheet and script to that
 * file's modification time, so a changed asset can never be served from
 * a stale cache. Idempotent: running it twice on unchanged input
 * produces byte-identical output.
 *
 * It used to also paste fragments from partials/ into index.html. The
 * redesign made index.html a single document, so that half is gone and
 * so are the fragments.
 *
 *   node scripts/build-site.mjs          write index.html
 *   node scripts/build-site.mjs --check  exit 1 if it would change
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FRONTEND = fileURLToPath(new URL("../src/frontend/", import.meta.url));
const PAGE = path.join(FRONTEND, "index.html");

/** `/styles/v2.css` or `/styles/v2.css?v=123` -> the file on disk. */
const ASSET = /(?:href|src)="(\/[^"?]+\.(?:css|js))(?:\?v=\d+)?"/g;

async function stamp(html) {
  const matches = [...html.matchAll(ASSET)];
  let out = html;

  for (const match of matches) {
    const assetPath = match[1];
    // Leading slash is an origin-relative URL, not a filesystem path.
    const onDisk = path.join(FRONTEND, assetPath.replace(/^\//, ""));

    let version;
    try {
      version = Math.floor((await stat(onDisk)).mtimeMs);
    } catch {
      // An asset that is not on disk is served from somewhere else, or is
      // a mistake worth seeing in the browser rather than hiding here.
      continue;
    }

    const attr = match[0].startsWith("href") ? "href" : "src";
    out = out.replace(match[0], `${attr}="${assetPath}?v=${version}"`);
  }

  return out;
}

const html = await readFile(PAGE, "utf8");
const next = await stamp(html);

if (process.argv.includes("--check")) {
  if (next !== html) {
    console.error("index.html is out of date — run: node scripts/build-site.mjs");
    process.exit(1);
  }
  console.log("index.html is up to date");
} else {
  if (next === html) {
    console.log("index.html is up to date");
  } else {
    await writeFile(PAGE, next);
    console.log("index.html asset versions stamped");
  }
}
