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
   * better-sqlite3 is a native addon reached only from `server.node.ts`, which
   * this app never imports. Marking it external stops the bundler following a
   * stray type-only edge into it and trying to bundle a `.node` binary.
   */
  serverExternalPackages: ["better-sqlite3", "@libsql/client", "libsql"],
};

export default nextConfig;
