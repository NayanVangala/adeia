import { Hono, type Context } from "hono";
import { approveAction, denyAction, expireAction } from "../actions/service.ts";
import type { AppEnv } from "../appEnv.ts";
import {
  renderApprovalPage,
  renderDecidedPage,
  renderExpiredPage,
} from "../approvals/page.ts";
import { ApprovalTokenError, markApprovalDecided, verifyApprovalToken } from "../approvals/token.ts";
import { getAction, getProject } from "../db/repo.ts";

/**
 * The approval surface. Not API-key authenticated — the token in the path is
 * the credential, which is why it is 32 random bytes, stored only as a hash,
 * single-use, and expiring.
 */
export function createApprovalRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // Approval pages must never sit in a shared cache or a browser back-forward
  // cache; a stale "Approve" button is a button that acts on old information.
  routes.use("*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store, no-cache, must-revalidate");
    c.header("referrer-policy", "no-referrer");
    c.header("x-robots-tag", "noindex, nofollow");
  });

  /**
   * Handles a token that cannot be used. An expired one also finalises the
   * action, because an action left in `pending_approval` forever is one the
   * SDK's `waitForAction` will poll until its own timeout.
   *
   * Expiring on GET is safe in a way that approving on GET is not: it is only
   * reachable after the deadline has already passed, it is idempotent, and it
   * strictly *removes* the ability to act on the request. A link-prefetcher
   * hitting a dead link only finishes killing it.
   */
  const handleTokenError = async (c: Context<AppEnv>, err: ApprovalTokenError) => {
    if (err.reason === "expired" && err.actionId) {
      await expireAction(c.get("deps"), err.actionId);
    }
    return c.html(renderExpiredPage(err.message), 410);
  };

  /**
   * Renders the decision page. **Mutates nothing** for a valid token.
   *
   * This is the single most important property in the system. Corporate mail
   * scanners, Slack and iMessage link unfurlers, and browser prefetch all issue
   * GET requests against links found in email. If this route decided anything,
   * every payment would approve itself the moment the message was delivered —
   * before a human had read it.
   */
  routes.get("/:token", async (c) => {
    try {
      const approval = await verifyApprovalToken(c.get("deps").db, c.req.param("token"));
      const action = await getAction(c.get("deps").db, approval.actionId);
      if (!action) return c.html(renderExpiredPage("this request no longer exists"), 410);

      const project = await getProject(c.get("deps").db, action.projectId);
      return c.html(
        renderApprovalPage(action, c.req.param("token"), {
          ...(project ? { projectName: project.name } : {}),
        }),
        200,
      );
    } catch (err) {
      if (err instanceof ApprovalTokenError) return handleTokenError(c, err);
      throw err;
    }
  });

  /**
   * Records the decision and acts on it. The only mutating verb here.
   */
  routes.post("/:token", async (c) => {
    const deps = c.get("deps");
    const token = c.req.param("token");

    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const decision = body["decision"];
    if (decision !== "approve" && decision !== "deny") {
      return c.html(renderExpiredPage("that was not a valid decision"), 400);
    }

    const decidedBy = deps.approverEmail ?? "approval link";

    try {
      // Spends the token first. Two simultaneous clicks race here, and the
      // conditional update means exactly one of them wins.
      const spent = await markApprovalDecided(deps.db, token, decision, decidedBy);
      if (!spent) {
        return c.html(renderExpiredPage("this request has already been decided"), 410);
      }

      const action =
        decision === "approve"
          ? await approveAction(deps, spent.actionId, decidedBy)
          : await denyAction(deps, spent.actionId, decidedBy);

      return c.html(renderDecidedPage(decision, action), 200);
    } catch (err) {
      if (err instanceof ApprovalTokenError) return handleTokenError(c, err);
      throw err;
    }
  });

  return routes;
}
