import { Hono } from "hono";
import type { AppEnv } from "../appEnv.ts";
import { apiKeyAuth } from "../auth/apiKey.ts";
import { getAction } from "../db/repo.ts";

export function createActionRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.use("*", apiKeyAuth);

  /**
   * An action belonging to another project returns 404, not 403. A 403 confirms
   * the id exists, which is a membership oracle over every action in the
   * system. Both answers mean "you cannot have this"; return the one that
   * leaks nothing.
   */
  routes.get("/:id", (c) => {
    const action = getAction(c.get("db"), c.req.param("id"));
    if (!action || action.projectId !== c.get("projectId")) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(action, 200);
  });

  return routes;
}
