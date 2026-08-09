import { ActionRequestSchema, type ActionStatus } from "@adeia/shared";
import { Hono } from "hono";
import { requestAction } from "../actions/service.ts";
import type { AppEnv } from "../appEnv.ts";
import { apiKeyAuth } from "../auth/apiKey.ts";
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

    const action = await requestAction(c.get("deps"), c.get("projectId"), parsed.data);
    return c.json(action, statusCodeFor(action.status));
  });

  /**
   * An action belonging to another project returns 404, not 403. A 403 confirms
   * the id exists, which is a membership oracle over every action in the
   * system. Both answers mean "you cannot have this"; return the one that
   * leaks nothing.
   */
  routes.get("/:id", (c) => {
    const action = getAction(c.get("deps").db, c.req.param("id"));
    if (!action || action.projectId !== c.get("projectId")) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(action, 200);
  });

  return routes;
}
