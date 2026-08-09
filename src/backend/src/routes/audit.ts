import { Hono } from "hono";
import type { AppEnv } from "../appEnv.ts";
import { apiKeyAuth } from "../auth/apiKey.ts";
import { getAction, listAudit, listProjectAudit, type AuditRow } from "../db/repo.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface AuditEventBody {
  id: string;
  actionId: string | null;
  event: string;
  data: unknown;
  createdAt: string;
}

function toBody(row: AuditRow): AuditEventBody {
  return {
    id: row.id,
    actionId: row.actionId,
    event: row.event,
    // Already redacted at write time; this only parses it back out of the
    // text column.
    data: row.data === null ? null : (JSON.parse(row.data) as unknown),
    createdAt: row.createdAt,
  };
}

function parseLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Mounted at `/v1`. Both routes are project-scoped exactly like
 * `GET /v1/actions/:id` — another project's trail is a 404, not a 403.
 */
export function createAuditRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.use("*", apiKeyAuth);

  /** The complete, ordered trail for one action. */
  routes.get("/actions/:id/audit", (c) => {
    const deps = c.get("deps");
    const action = getAction(deps.db, c.req.param("id"));
    if (!action || action.projectId !== c.get("projectId")) {
      return c.json({ error: "not_found" }, 404);
    }

    return c.json({ events: listAudit(deps.db, action.id).map(toBody) }, 200);
  });

  /** Everything the project has done, newest first. */
  routes.get("/audit", (c) => {
    const { events, nextCursor } = listProjectAudit(c.get("deps").db, c.get("projectId"), {
      limit: parseLimit(c.req.query("limit")),
      cursor: c.req.query("cursor"),
    });

    return c.json({ events: events.map(toBody), nextCursor }, 200);
  });

  return routes;
}
