/**
 * The app is TypeScript run straight from source everywhere else in this repo —
 * `node --experimental-strip-types`, no build step — and its imports carry
 * explicit `.ts` extensions because that is what NodeNext resolution wants.
 * Next.js compiles them the same way it compiles anything else under the
 * workspace; nothing here is in node_modules, so no transpilePackages is
 * needed.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,

  /**
   * Native addons reached only from `server.node.ts` and the scripts, which
   * this app never imports. Marking them external stops the bundler following
   * a stray type-only edge into one and trying to bundle a `.node` binary.
   *
   * `@libsql/client` is deliberately NOT in this list. External means the
   * bundler emits a runtime `require` of the package *root*, and that root is
   * `lib-cjs/node.js` — the build that opens local files and therefore loads
   * `@libsql/<platform>`. The subpath this app imports, `@libsql/client/web`,
   * would be discarded in favour of it, and the function would die on its
   * first request with `Cannot find module '@libsql/linux-arm64-gnu'`.
   * Bundled instead, the web entry is followed as written and no native
   * binding is reachable at all.
   */
  serverExternalPackages: ["better-sqlite3", "libsql"],

  /**
   * Next traces `.env` files into the function by default. On a build produced
   * from a developer's machine that means shipping their credentials — the
   * Turso token, the SMTP app password, the API keys — into the deployment,
   * where `loadEnvFile` finds them and prefers them to the variables the host
   * actually set. The visible symptom was a production sign-in redirecting to
   * `http://localhost:3000`.
   *
   * Production variables come from the platform. There is nothing here a
   * deployment should be reading.
   */
  outputFileTracingExcludes: {
    "**": ["../../.env", "../../.env.local", "../../.env.*"],
  },
};

export default nextConfig;
