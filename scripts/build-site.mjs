/**
 * Assembles src/frontend/index.html from the fragments in partials/.
 *
 * The landing page is four fragments pasted into one document. They were
 * being pasted by hand, which meant a fix could land in a partial and
 * never reach the page — so this does the pasting, and the marker pairs
 * already in index.html are what it writes between.
 *
 * It also rewrites the ?v= on every local stylesheet and script to the
 * file's modification time, so a changed asset cannot be served from a
 * stale cache. Both steps are idempotent: running it twice on unchanged
 * input produces byte-identical output.
 *
 *   node scripts/build-site.mjs          write index.html
 *   node scripts/build-site.mjs --check  exit 1 if it would change
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FRONTEND = fileURLToPath(new URL("../src/frontend/", import.meta.url));
const PAGE = path.join(FRONTEND, "index.html");

/** Marker name in index.html -> fragment file in partials/. */
const SECTIONS = {
  HERO: "hero.html",
  CAPABILITY: "capability.html",
  STATEMENT: "statement.html",
  PROOF: "proof.html",
  CLOSING: "closing.html",
};

/** Escape a string for use inside a RegExp. */
function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assemble(html) {
  let out = html;

  for (const [marker, file] of Object.entries(SECTIONS)) {
    const open = `<!-- @@${marker}@@ -->`;
    const close = `<!-- @@END-${marker}@@ -->`;

    if (!out.includes(open) || !out.includes(close)) {
      throw new Error(`index.html is missing the ${marker} marker pair`);
    }

    const fragment = await readFile(path.join(FRONTEND, "partials", file), "utf8");
    const block = new RegExp(`${escape(open)}[\\s\\S]*?${escape(close)}`);
    // $ is special in a replacement string; a function body is not.
    out = out.replace(block, () => `${open}\n${fragment.trim()}\n${close}`);
  }

  return out;
}

async function bustCaches(html) {
  const refs = [...html.matchAll(/(href|src)="([a-z0-9/._-]+\.(?:css|js))(\?v=\d+)?"/gi)];
  let out = html;

  for (const [, attr, asset] of refs) {
    let mtime;
    try {
      mtime = (await stat(path.join(FRONTEND, asset))).mtime;
    } catch {
      // A reference to a file that does not exist is a broken page, not a
      // cache problem. Say so rather than papering over it with a version.
      throw new Error(`index.html references ${asset}, which does not exist`);
    }
    const version = Math.floor(mtime.getTime() / 1000);
    const pattern = new RegExp(`${attr}="${escape(asset)}(?:\\?v=\\d+)?"`, "g");
    out = out.replace(pattern, `${attr}="${asset}?v=${version}"`);
  }

  return out;
}

const check = process.argv.includes("--check");
const before = await readFile(PAGE, "utf8");
const after = await bustCaches(await assemble(before));

if (before === after) {
  console.log("index.html is up to date");
  process.exit(0);
}

if (check) {
  console.error("index.html is stale — run: npm run site:build");
  process.exit(1);
}

await writeFile(PAGE, after);
console.log("index.html rebuilt from partials/");
