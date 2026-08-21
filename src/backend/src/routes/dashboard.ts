import { env } from "../env.ts";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { isBlockedHost } from "@adeia/shared";
import { approveAction, denyAction, NotPendingApprovalError } from "../actions/service.ts";
import type { AppDeps, AppEnv } from "../appEnv.ts";
import { generateApiKey, hashApiKey } from "../auth/apiKey.ts";
import {
  csrfMatches,
  resolveSession,
  SESSION_COOKIE,
  type ResolvedSession,
} from "../auth/session.ts";
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
  getAction,
  getPolicy,
  insertPolicy,
  insertProject,
  listActionsByProject,
  getProject,
  listProjectsByOwner,
  renameProject,
  toPolicy,
  updatePolicyConfig,
  updateProjectKeyHash,
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

/**
 * Turns what someone typed into a hostname, or null.
 *
 * Accepts a bare host and also a pasted URL, because pasting the endpoint you
 * were looking at is the obvious thing to do. Rejects anything with a path,
 * a wildcard or a space: the allowlist is compared against a parsed hostname,
 * so a value that could never match is a mistake worth naming now.
 */
export function normaliseHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;

  // A pasted URL. Take its hostname and discard the rest.
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname || null;
    } catch {
      return null;
    }
  }

  if (/[/\s?#*]/.test(trimmed)) return null;
  // Hostname shape: labels of letters, digits and hyphens, at least one dot.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Picks which of the caller's projects a request is about.
 *
 * The candidate is found *within* the owner's own list rather than fetched by
 * id and checked afterwards. The difference matters: a fetch-then-check can be
 * forgotten at one call site and becomes an IDOR, where a list-then-find
 * cannot express the bug at all — an id the caller does not own is simply not
 * in the array. Every project-scoped route here goes through this.
 *
 * No match falls back to the first project rather than erroring, so a stale
 * link to a project that was renamed or a bookmark from another account lands
 * somewhere sane instead of on a failure.
 */
function selectProject(owned: Project[], requestedId: string | undefined): Project | undefined {
  if (!requestedId) return owned[0];
  return owned.find((p) => p.id === requestedId) ?? owned[0];
}

/** Creates the project, both policies and the first key. Returns the key once. */
async function provisionProject(
  db: Db,
  userId: string,
  login: string,
): Promise<{ project: Project; apiKey: string }> {
  const apiKey = generateApiKey();
  const project = await insertProject(db, {
    name: `${login}'s project`,
    apiKeyHash: hashApiKey(apiKey),
    ownerUserId: userId,
  });

  await insertPolicy(db, { ...STARTER_PAYMENT_POLICY, projectId: project.id });
  await insertPolicy(db, {
    projectId: project.id,
    actionType: STARTER_HTTP_POLICY.actionType,
    requiresApproval: STARTER_HTTP_POLICY.requiresApproval,
    config: { ...STARTER_HTTP_POLICY.config },
  });

  return { project, apiKey };
}

/**
 * Builds the whole dashboard for one project.
 *
 * Shared by the GET and by the key-rotation POST, which renders directly
 * instead of redirecting. Everything it shows is read back from the database
 * rather than carried over from whatever just happened, so the page cannot
 * claim a state the engine would not agree with.
 */
async function renderDashboardFor(
  deps: AppDeps,
  session: ResolvedSession,
  project: Project,
  freshApiKey?: string,
  flash?: { text: string; kind: "approved" | "denied" },
): Promise<string> {
  const httpRow = await getPolicy(deps.db, project.id, "http");
  let allowedHosts: string[] = [];
  if (httpRow) {
    const parsed = toPolicy(httpRow);
    if (parsed.actionType === "http") allowedHosts = parsed.allowedHosts;
  }

  const records = await listActionsByProject(deps.db, project.id);
  const verdicts = await classifierVerdictsFor(
    deps.db,
    records.map((r) => r.id),
  );

  const owned = await listProjectsByOwner(deps.db, session.user.id);

  return renderDashboard({
    user: { login: session.user.login, avatarUrl: session.user.avatarUrl },
    projectName: project.name,
    projectId: project.id,
    projects: owned.map((p) => ({ id: p.id, name: p.name })),
    actions: records.map((action) => ({
      action,
      classifier: verdicts.get(action.id) ?? null,
    })),
    counts: {
      waiting: await countActionsByStatus(deps.db, project.id, "pending_approval"),
      ranToday: await countActionsByStatusToday(deps.db, project.id, "executed"),
      refusedToday: await countActionsByStatusToday(deps.db, project.id, "denied"),
    },
    freshApiKey,
    csrf: session.csrf,
    flash,
    allowedHosts,
    baseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`,
  });
}

export function createDashboardRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Deciding an action from the dashboard.
   *
   * Three gates, in this order, and the middle one is the important one:
   *
   * 1. A live session. No cookie, no decision.
   * 2. The action belongs to a project this user owns. Without this check the
   *    action id — which is not secret, it appears in API responses and logs —
   *    would be enough for any signed-in stranger to release someone else's
   *    payment.
   * 3. A matching CSRF token, so a form on another site cannot approve
   *    something using a cookie the browser attaches on its own.
   */
  routes.post("/dashboard/actions/:id/decision", async (c) => {
    const deps = c.get("deps");
    const session = await resolveSession(deps.db, getCookie(c, SESSION_COOKIE));
    if (!session) return c.redirect("/dashboard", 302);

    const form = await c.req.parseBody();
    if (!csrfMatches(session.csrf, typeof form["csrf"] === "string" ? form["csrf"] : undefined)) {
      return c.text("This form has expired. Reload the dashboard and try again.", 403);
    }

    const action = await getAction(deps.db, c.req.param("id"));
    const owned = (await listProjectsByOwner(deps.db, session.user.id)).map((p) => p.id);
    // 404 rather than 403: someone probing action ids learns nothing about
    // whether the id exists.
    if (!action || !owned.includes(action.projectId)) {
      return c.text("Not found.", 404);
    }

    const decision = form["decision"];
    if (decision !== "approve" && decision !== "deny") return c.text("Unknown decision.", 400);

    // Recorded as `decided_by`. A GitHub login the session proves, rather than
    // the emailed flow's "whoever held the token".
    const decidedBy = `github:${session.user.login}`;

    try {
      if (decision === "approve") {
        await approveAction(deps, action.id, decidedBy);
      } else {
        await denyAction(deps, action.id, decidedBy);
      }
    } catch (err) {
      // Already decided elsewhere — the emailed link, or a double-submitted
      // form. Not an error worth a stack trace; say so and move on.
      if (err instanceof NotPendingApprovalError) {
        return c.redirect("/dashboard?decided=already", 302);
      }
      throw err;
    }

    return c.redirect(`/dashboard?decided=${decision}`, 302);
  });

  /**
   * Editing the host allowlist.
   *
   * The validation here is not the security boundary — `evaluate()` rejects a
   * private host before the allowlist is even consulted, and the adapter
   * re-resolves DNS at execution time. It exists so a mistake is refused with a
   * sentence the person can act on, rather than silently accepted and then
   * mysteriously never working.
   */
  routes.post("/dashboard/policy/hosts", async (c) => {
    const deps = c.get("deps");
    const session = await resolveSession(deps.db, getCookie(c, SESSION_COOKIE));
    if (!session) return c.redirect("/dashboard", 302);

    const form = await c.req.parseBody();
    if (!csrfMatches(session.csrf, typeof form["csrf"] === "string" ? form["csrf"] : undefined)) {
      return c.text("This form has expired. Reload the dashboard and try again.", 403);
    }

    const project = selectProject(
      await listProjectsByOwner(deps.db, session.user.id),
      typeof form["projectId"] === "string" ? form["projectId"] : undefined,
    );
    if (!project) return c.redirect("/dashboard", 302);

    const row = await getPolicy(deps.db, project.id, "http");
    if (!row) return c.redirect("/dashboard", 302);

    const policy = toPolicy(row);
    if (policy.actionType !== "http") return c.redirect("/dashboard", 302);

    let hosts = [...policy.allowedHosts];

    const remove = form["remove"];
    if (typeof remove === "string") {
      hosts = hosts.filter((h) => h !== remove.toLowerCase());
    }

    const add = form["add"];
    if (typeof add === "string" && add.trim() !== "") {
      const candidate = normaliseHost(add);
      if (!candidate) {
        return c.redirect("/dashboard?policy=invalid", 302);
      }
      if (isBlockedHost(candidate)) {
        // Refused here as well as in the engine, because "I added it and
        // nothing happened" is a worse experience than being told why.
        return c.redirect("/dashboard?policy=private", 302);
      }
      if (!hosts.includes(candidate)) hosts.push(candidate);
    }

    await updatePolicyConfig(deps.db, row.id, {
      allowedHosts: hosts,
      approvalMethods: policy.approvalMethods,
      classifyMethods: policy.classifyMethods,
      deniedMethods: policy.deniedMethods,
      maxCallsPerDay: policy.maxCallsPerDay,
    });

    return c.redirect("/dashboard?policy=saved", 302);
  });

  /**
   * Mints a replacement API key.
   *
   * Destructive by design: the old key stops working the moment the hash is
   * overwritten, and there is no grace period. That is the honest behaviour
   * for a credential you rotate because you think it leaked — a window where
   * both keys work is a window the thief also has.
   *
   * The new key is handed to the renderer and never stored. It exists in this
   * response and nowhere else.
   */
  routes.post("/dashboard/key", async (c) => {
    const deps = c.get("deps");
    const session = await resolveSession(deps.db, getCookie(c, SESSION_COOKIE));
    if (!session) return c.redirect("/dashboard", 302);

    const form = await c.req.parseBody();
    if (!csrfMatches(session.csrf, typeof form["csrf"] === "string" ? form["csrf"] : undefined)) {
      return c.text("This form has expired. Reload the dashboard and try again.", 403);
    }

    const project = selectProject(
      await listProjectsByOwner(deps.db, session.user.id),
      typeof form["projectId"] === "string" ? form["projectId"] : undefined,
    );
    if (!project) return c.redirect("/dashboard", 302);

    const apiKey = generateApiKey();
    await updateProjectKeyHash(deps.db, project.id, hashApiKey(apiKey));

    // Rendered directly rather than redirected, because a redirect would have
    // to carry the key in a URL — into browser history, the referer header and
    // every log between here and the user.
    return c.html(await renderDashboardFor(deps, session, project, apiKey));
  });

  /**
   * A new project. Same provisioning the first sign-in uses, so a second
   * project is not a lesser one: it gets both starter policies and its own
   * key, and the key is shown once on the way back exactly as the first was.
   */
  routes.post("/dashboard/project/new", async (c) => {
    const deps = c.get("deps");
    const session = await resolveSession(deps.db, getCookie(c, SESSION_COOKIE));
    if (!session) return c.redirect("/dashboard", 302);

    const form = await c.req.parseBody();
    if (!csrfMatches(session.csrf, typeof form["csrf"] === "string" ? form["csrf"] : undefined)) {
      return c.text("This form has expired. Reload the dashboard and try again.", 403);
    }

    const raw = typeof form["name"] === "string" ? form["name"].trim() : "";
    const created = await provisionProject(deps.db, session.user.id, session.user.login);
    if (raw) await renameProject(deps.db, created.project.id, session.user.id, raw.slice(0, 60));

    /* Rendered rather than redirected, for the same reason the first sign-in
       renders: the key is shown once and a redirect would have to carry it in
       a URL, where it lands in history and in any log the request passes. */
    return c.html(
      await renderDashboardFor(
        deps,
        session,
        (await getProject(deps.db, created.project.id))!,
        created.apiKey,
      ),
    );
  });

  /** Renames a project. Owner-scoped in the statement itself. */
  routes.post("/dashboard/project/rename", async (c) => {
    const deps = c.get("deps");
    const session = await resolveSession(deps.db, getCookie(c, SESSION_COOKIE));
    if (!session) return c.redirect("/dashboard", 302);

    const form = await c.req.parseBody();
    if (!csrfMatches(session.csrf, typeof form["csrf"] === "string" ? form["csrf"] : undefined)) {
      return c.text("This form has expired. Reload the dashboard and try again.", 403);
    }

    const project = selectProject(
      await listProjectsByOwner(deps.db, session.user.id),
      typeof form["projectId"] === "string" ? form["projectId"] : undefined,
    );
    if (!project) return c.redirect("/dashboard", 302);

    const raw = typeof form["name"] === "string" ? form["name"].trim() : "";
    /* An empty name would leave a project with nothing to click on in the
       switcher, so it is ignored rather than written. Capped because this is
       rendered into a heading. */
    if (raw) await renameProject(deps.db, project.id, session.user.id, raw.slice(0, 60));

    return c.redirect(`/dashboard?p=${encodeURIComponent(project.id)}`, 302);
  });

  routes.get("/dashboard", async (c) => {
    const deps = c.get("deps");
    const session = await resolveSession(deps.db, getCookie(c, SESSION_COOKIE));

    if (!session) return c.html(renderSignIn(Boolean(deps.oauth)));

    const { user } = session;
    let projects = await listProjectsByOwner(deps.db, user.id);
    let freshApiKey: string | undefined;

    if (projects.length === 0) {
      const created = await provisionProject(deps.db, user.id, user.login);
      projects = [created.project];
      freshApiKey = created.apiKey;
    }

    const project = selectProject(projects, c.req.query("p"))!;

    // Set by the redirect after a decision, so the page confirms what happened
    // rather than looking identical to a reload.
    const decided = c.req.query("decided");
    const policyResult = c.req.query("policy");
    const flash =
      decided === "approve"
        ? { text: "Approved. The action is running now.", kind: "approved" as const }
        : decided === "deny"
          ? { text: "Denied. It was never sent.", kind: "denied" as const }
          : decided === "already"
            ? { text: "That one had already been decided.", kind: "denied" as const }
            : policyResult === "saved"
              ? { text: "Policy updated.", kind: "approved" as const }
              : policyResult === "invalid"
                ? {
                    text: "That is not a hostname. Use something like api.github.com — no paths, no wildcards.",
                    kind: "denied" as const,
                  }
                : policyResult === "private"
                  ? {
                      text: "That address is private, loopback or link-local. Adeia refuses those everywhere, so allowing it here would not work anyway.",
                      kind: "denied" as const,
                    }
                  : undefined;

    return c.html(await renderDashboardFor(deps, session, project, freshApiKey, flash));
  });

  return routes;
}
