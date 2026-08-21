import { ActionRequestSchema, type ActionStatus } from "@adeia/shared";
import { Hono } from "hono";
import { requestAction } from "../actions/service.ts";
import type { AppEnv } from "../appEnv.ts";
import { apiKeyAuth } from "../auth/apiKey.ts";
import { countActionsSince } from "../db/repo.ts";
import { env } from "../env.ts";
import { getAction } from "../db/repo.ts";

/**
 * Maps an outcome to a status code. Each of these carries meaning an SDK acts
 * on, so none of them is interchangeable with another:
 *
 * - `200` for a denial. The API call succeeded and is reporting a policy
 *   outcome. A client that reads a denial as a transport error retries a
 *   refused payment forever.
 * - `202` for a pause. The only code that says "not finished — poll this".
 * - `201` for a failure. A declined card is a recorded outcome, not a server
 *   error; a 500 would make callers retry a payment that already landed.
 */
function statusCodeFor(status: ActionStatus): 200 | 201 | 202 {
  switch (status) {
    case "executed":
    case "failed":
      return 201;
    case "pending_approval":
      return 202;
    default:
      return 200;
  }
}

export function createActionRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.use("*", apiKeyAuth);

  routes.post("/", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }

    /* A ceiling on damage per unit time.
   
       The policy engine already bounds what an agent may spend in a day. This
       bounds how fast it can get there — an agent in a hot loop reaches a
       daily cap in seconds, and every attempt on the way is a row in the audit
       trail that every later query has to read past.
   
       Counted from the actions table rather than from a counter, because a
       serverless deployment has no memory between invocations: a module-level
       tally would be per-instance, would reset on every cold start, and would
       be worth roughly nothing. Rows are the only shared state there is.
   
       A fixed window, not a sliding one. It admits up to twice the limit
       across a boundary, which is the standard trade and is fine here: this
       exists to stop a runaway loop, not to meter billing to the request. */
    const limit = c.get("deps").actionsPerMinute ?? env.ADEIA_ACTIONS_PER_MINUTE;
    if (limit > 0) {
      const since = new Date(Date.now() - 60_000).toISOString();
      const recent = await countActionsSince(c.get("deps").db, c.get("projectId"), since);
      if (recent >= limit) {
        /* 429 with Retry-After, because a client that cannot tell "slow down"
           from "you are broken" retries immediately and makes it worse. */
        c.header("retry-after", "60");
        return c.json(
          {
            error: "rate_limited",
            message: `This project has created ${recent} actions in the last minute, and the limit is ${limit}. Nothing was recorded for this request.`,
          },
          429,
        );
      }
    }

    const action = await requestAction(c.get("deps"), c.get("projectId"), parsed.data);
    return c.json(action, statusCodeFor(action.status));
  });

  /**
   * An action belonging to another project returns 404, not 403. A 403 confirms
   * the id exists, which is a membership oracle over every action in the
   * system. Both answers mean "you cannot have this"; return the one that
   * leaks nothing.
   */
  routes.get("/:id", async (c) => {
    const action = await getAction(c.get("deps").db, c.req.param("id"));
    if (!action || action.projectId !== c.get("projectId")) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(action, 200);
  });

  return routes;
}
