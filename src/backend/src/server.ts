import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import Stripe from "stripe";
import type { RequestDeps } from "./actions/service.ts";
import { createStripeAdapter } from "./adapters/stripe.ts";
import { createRegistry } from "./adapters/types.ts";
import type { AppEnv } from "./appEnv.ts";
import { createDb, migrate } from "./db/client.ts";
import { env, requireStripeSecretKey } from "./env.ts";
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
  // Before anything else. A server that starts and only discovers it has no
  // usable payment key on the first request is a server that fails in front of
  // an audience.
  const stripeSecretKey = requireStripeSecretKey();

  const db = createDb(env.ADEIA_DB_PATH);
  migrate(db);

  const adapters = createRegistry([createStripeAdapter(new Stripe(stripeSecretKey))]);

  // Phase 5 replaces this stub with the real approval email;
  // `actions/service.ts` does not change when it does.
  const onApprovalNeeded = async (actionId: string): Promise<void> => {
    console.log(`[adeia] action ${actionId} needs approval — no notifier wired yet (Phase 5)`);
  };

  const app = createApp({ db, adapters, onApprovalNeeded });

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`[adeia] listening on http://localhost:${info.port}  (db: ${env.ADEIA_DB_PATH})`);
    // Names only. The key itself is never logged.
    console.log(`[adeia] adapters: ${[...adapters.values()].map((a) => a.name).join(", ")}  (stripe test mode)`);
  });
}

// `import.meta.main` only exists on Node 24+; argv works on every supported version.
const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) boot();
