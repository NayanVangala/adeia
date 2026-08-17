import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../appEnv.ts";
import { generateApiKey, hashApiKey } from "../auth/apiKey.ts";
import { resolveSession, SESSION_COOKIE } from "../auth/session.ts";
import {
  renderDashboard,
  renderSignIn,
  type DashboardAction,
} from "../dashboard/page.ts";
import type { Db } from "../db/client.ts";
import {
  classifierVerdictsFor,
  countActionsByStatus,
  countActionsByStatusToday,
  insertPolicy,
  insertProject,
  listActionsByProject,
  listProjectsByOwner,
  type Project,
} from "../db/repo.ts";

/**
 * The dashboard.
 *
 * Signing in for the first time also creates a project, its policies and its
 * API key. That is deliberate: before this existed the only way to get a key
 * was to run `npm run seed` on the machine hosting Adeia, which meant nobody
 * but the operator could ever use it.
 */

/**
 * What a new project starts with.
 *
 * Mirrors `scripts/seed.ts`, and the two are checked against each other by a
 * test — a new user landing on looser defaults than the documented ones would
 * be a quiet downgrade nobody asked for.
 */
export const STARTER_PAYMENT_POLICY = {
  actionType: "payment",
  maxAmountCents: 5_000,
  hardMaxAmountCents: 100_000,
  dailyCapCents: 200_000,
  allowedRecipients: null,
  requiresApproval: false,
} as const;

export const STARTER_HTTP_POLICY = {
  actionType: "http",
  requiresApproval: false,
  config: {
    // Empty. A host allowlist is the only thing bounding an outbound call, and
    // guessing which hosts a stranger trusts is not something to do on their
    // behalf — an empty list denies everything, which is the safe starting
    // point. The dashboard says so, rather than leaving them to wonder.
    allowedHosts: [] as string[],
    approvalMethods: ["DELETE"],
    classifyMethods: ["POST", "PUT", "PATCH"],
    deniedMethods: [] as string[],
    maxCallsPerDay: 100,
  },
} as const;

/** Creates the project, both policies and the first key. Returns the key once. */
function provisionProject(
  db: Db,
  userId: string,
  login: string,
): { project: Project; apiKey: string } {
  const apiKey = generateApiKey();
  const project = insertProject(db, {
    name: `${login}'s project`,
    apiKeyHash: hashApiKey(apiKey),
    ownerUserId: userId,
  });

  insertPolicy(db, { ...STARTER_PAYMENT_POLICY, projectId: project.id });
  insertPolicy(db, {
    projectId: project.id,
    actionType: STARTER_HTTP_POLICY.actionType,
    requiresApproval: STARTER_HTTP_POLICY.requiresApproval,
    config: { ...STARTER_HTTP_POLICY.config },
  });

  return { project, apiKey };
}

export function createDashboardRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/dashboard", (c) => {
    const deps = c.get("deps");
    const session = resolveSession(deps.db, getCookie(c, SESSION_COOKIE));

    if (!session) return c.html(renderSignIn(Boolean(deps.oauth)));

    const { user } = session;
    let projects = listProjectsByOwner(deps.db, user.id);
    let freshApiKey: string | undefined;

    if (projects.length === 0) {
      const created = provisionProject(deps.db, user.id, user.login);
      projects = [created.project];
      freshApiKey = created.apiKey;
    }

    // One project per user for now. The query is by owner, so adding a project
    // switcher later needs a selector, not a different data path.
    const project = projects[0]!;

    const records = listActionsByProject(deps.db, project.id);
    const verdicts = classifierVerdictsFor(
      deps.db,
      records.map((r) => r.id),
    );

    const actions: DashboardAction[] = records.map((action) => ({
      action,
      classifier: verdicts.get(action.id) ?? null,
    }));

    return c.html(
      renderDashboard({
        user: { login: user.login, avatarUrl: user.avatarUrl },
        projectName: project.name,
        actions,
        counts: {
          waiting: countActionsByStatus(deps.db, project.id, "pending_approval"),
          ranToday: countActionsByStatusToday(deps.db, project.id, "executed"),
          refusedToday: countActionsByStatusToday(deps.db, project.id, "denied"),
        },
        freshApiKey,
      }),
    );
  });

  return routes;
}
