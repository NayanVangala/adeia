import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AppEnv } from "./appEnv.ts";
import { createDb, migrate, type Db } from "./db/client.ts";
import { env } from "./env.ts";
import { createActionRoutes } from "./routes/actions.ts";

export interface AppDeps {
  db: Db;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("db", deps.db);
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/v1/actions", createActionRoutes());

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    console.error("[adeia] unhandled error:", err);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}

export function boot(): void {
  const db = createDb(env.ADEIA_DB_PATH);
  migrate(db);
  const app = createApp({ db });

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[adeia] listening on http://localhost:${info.port}  (db: ${env.ADEIA_DB_PATH})`);
  });
}

// `import.meta.main` only exists on Node 24+; argv works on every supported version.
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) boot();
