import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { RequestDeps } from "./actions/service.ts";
import { createFakeAdapter } from "./adapters/fake.ts";
import { createRegistry } from "./adapters/types.ts";
import type { AppEnv } from "./appEnv.ts";
import { createDb, migrate } from "./db/client.ts";
import { env } from "./env.ts";
import { createActionRoutes } from "./routes/actions.ts";

export type AppDeps = RequestDeps;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
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

  // Phase 4 swaps the fake adapter for Stripe. Phase 5 replaces this stub with
  // the real approval email; `actions/service.ts` does not change for either.
  const adapters = createRegistry([createFakeAdapter()]);
  const onApprovalNeeded = async (actionId: string): Promise<void> => {
    console.log(`[adeia] action ${actionId} needs approval — no notifier wired yet (Phase 5)`);
  };

  const app = createApp({ db, adapters, onApprovalNeeded });

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[adeia] listening on http://localhost:${info.port}  (db: ${env.ADEIA_DB_PATH})`);
    console.log(`[adeia] adapters: ${[...adapters.values()].map((a) => a.name).join(", ")}`);
  });
}

// `import.meta.main` only exists on Node 24+; argv works on every supported version.
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) boot();
