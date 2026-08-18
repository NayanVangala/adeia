/**
 * Cache-busts every page's local assets.
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
 * It also used to stamp index.html alone, which was right while it was
 * the only page on the new stylesheets. Now every page shares them, and
 * stamping one page means a changed v2.css is fetched fresh on the
 * landing page and served stale on the eight behind it.
 *
 *   node scripts/build-site.mjs          write every page
 *   node scripts/build-site.mjs --check  exit 1 if any would change
 */

import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FRONTEND = fileURLToPath(new URL("../src/frontend/", import.meta.url));

/** `/styles/v2.css` or `/styles/v2.css?v=123` -> the file on disk. */
const ASSET = /(?:href|src)="(\/[^"?]+\.(?:css|js))(?:\?v=\d+)?"/g;

/** Cached, because nine pages reference the same six files. */
const versions = new Map();

async function versionOf(assetPath) {
  if (versions.has(assetPath)) return versions.get(assetPath);

  // Leading slash is an origin-relative URL, not a filesystem path.
  const onDisk = path.join(FRONTEND, assetPath.replace(/^\//, ""));

  let version;
  try {
    version = Math.floor((await stat(onDisk)).mtimeMs);
  } catch {
    // An asset that is not on disk is served from somewhere else, or is
    // a mistake worth seeing in the browser rather than hiding here.
    version = null;
  }

  versions.set(assetPath, version);
  return version;
}

async function stamp(html) {
  let out = html;

  for (const match of html.matchAll(ASSET)) {
    const version = await versionOf(match[1]);
    if (version === null) continue;

    const attr = match[0].startsWith("href") ? "href" : "src";
    out = out.replace(match[0], `${attr}="${match[1]}?v=${version}"`);
  }

  return out;
}

const pages = (await readdir(FRONTEND)).filter((name) => name.endsWith(".html")).sort();

const check = process.argv.includes("--check");
const stale = [];
let written = 0;

for (const page of pages) {
  const file = path.join(FRONTEND, page);
  const html = await readFile(file, "utf8");
  const next = await stamp(html);
  if (next === html) continue;

  if (check) {
    stale.push(page);
  } else {
    await writeFile(file, next);
    written += 1;
  }
}

if (check) {
  if (stale.length > 0) {
    console.error(
      `out of date (${stale.join(", ")}) — run: node scripts/build-site.mjs`,
    );
    process.exit(1);
  }
  console.log(`${pages.length} pages are up to date`);
} else {
  console.log(
    written === 0
      ? `${pages.length} pages are up to date`
      : `stamped ${written} of ${pages.length} pages`,
  );
}
