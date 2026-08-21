import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds and deploys to Vercel, with `.env` moved out of the way.
 *
 * Three facts collide here.
 *
 *   1. Next traces `.env` into the serverless function whenever the file
 *      exists at build time. `outputFileTracingExcludes` does not stop it.
 *   2. A build produced on a developer's machine therefore carries that
 *      developer's credentials — Turso token, SMTP password, API keys — into
 *      the deployment, where `loadEnvFile` reads them in preference to the
 *      variables the platform set. The visible symptom was a production
 *      sign-in redirecting to `http://localhost:3000`.
 *   3. Refusing to upload it via `.vercelignore` does not help either: the
 *      file map still names it, and the deploy fails with
 *      `ENOENT: lstat '/vercel/path0/.env'`.
 *
 * The only thing that resolves all three is for the file to be absent while
 * the build runs. Production variables come from Vercel, so nothing is lost —
 * `vercel build` injects them itself.
 *
 * The rename is undone in a `finally`, so an interrupted or failing build
 * leaves `.env` where it was rather than hidden under another name.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/* Every `.env*` at the root, not just `.env`. Next traces the family — the
   `.env.local` that `vercel link` writes is picked up the same way, and the
   deploy fails on whichever one is left behind. */
const NAMES = readdirSync(ROOT).filter((f) => f === ".env" || f.startsWith(".env."));

/* Held outside the repository, not beside it under another name: the tracing
   root is the repository, so a file renamed in place is traced under its new
   name and nothing is gained. */
const HOLD = join(tmpdir(), "adeia-deploy-env-hold");

/** Inherits stdio so the Vercel CLI's own output is the output. */
function run(args) {
  const r = spawnSync("npx", args, { cwd: ROOT, stdio: "inherit", shell: false });
  if (r.status !== 0) throw new Error(`vercel ${args.join(" ")} exited ${r.status}`);
}

const held = [];
for (const [i, name] of NAMES.entries()) {
  const from = `${ROOT}${name}`;
  if (!existsSync(from)) continue;
  const to = `${HOLD}-${i}`;
  renameSync(from, to);
  held.push([to, from]);
}

try {
  run(["vercel", "build", "--prod", "--yes"]);
} finally {
  // Restored whatever happened to the build. A hidden .env is worse than a
  // failed deploy: the next `npm run dev` starts against nothing.
  for (const [to, from] of held) renameSync(to, from);
}

run(["vercel", "deploy", "--prebuilt", "--prod", "--yes"]);
