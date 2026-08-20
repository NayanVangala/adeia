import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../appEnv.ts";
import { authorizeUrl, exchangeCode, fetchProfile, GithubOauthError } from "../auth/github.ts";
import { endSession, mintSession, resolveSession, SESSION_COOKIE, SESSION_TTL_MS } from "../auth/session.ts";
import {
  consumeOauthState,
  deleteExpiredOauthStates,
  insertOauthState,
  upsertUserFromGithub,
} from "../db/repo.ts";
import { renderSignInUnavailable } from "../dashboard/page.ts";

/**
 * Signing in.
 *
 * The whole flow is three redirects and one exchange, and almost all of the
 * code here is refusing things:
 *
 * - A callback whose `state` we did not issue is refused. That parameter is
 *   the only thing stopping somebody from handing your browser their own
 *   authorization code and binding your session to their GitHub account.
 * - State is single-use and short-lived, spent by a conditional UPDATE so two
 *   simultaneous callbacks cannot both win.
 * - The session cookie is httpOnly, so a cross-site script cannot read it, and
 *   `sameSite=Lax`, which is the strictest value that still survives the
 *   top-level redirect back from GitHub.
 */

const STATE_TTL_MS = 10 * 60 * 1_000;
const STATE_COOKIE = "adeia_oauth_state";

const hashState = (state: string): string => createHash("sha256").update(state).digest("hex");

/** Secure only over https: a `secure` cookie is dropped on plain localhost. */
function cookieSecurity(redirectUri: string): { secure: boolean } {
  return { secure: redirectUri.startsWith("https://") };
}

export function createAuthRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get("/github", async (c) => {
    const oauth = c.get("deps").oauth;
    if (!oauth) return c.html(renderSignInUnavailable(), 503);

    // Cheap housekeeping on a route nobody hammers.
    await deleteExpiredOauthStates(c.get("deps").db);

    const state = randomBytes(32).toString("base64url");
    await insertOauthState(c.get("deps").db, {
      stateHash: hashState(state),
      expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
    });

    // Stored server-side *and* in a cookie. The database row stops replay; the
    // cookie proves the callback arrived in the same browser that started the
    // handshake, which the row alone cannot show.
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: STATE_TTL_MS / 1_000,
      ...cookieSecurity(oauth.redirectUri),
    });

    return c.redirect(authorizeUrl(oauth, state), 302);
  });

  routes.get("/github/callback", async (c) => {
    const deps = c.get("deps");
    const oauth = deps.oauth;
    if (!oauth) return c.html(renderSignInUnavailable(), 503);

    const code = c.req.query("code");
    const state = c.req.query("state");
    const cookieState = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });

    if (!code || !state) return c.text("Sign-in was cancelled or incomplete.", 400);

    // Both checks are required and neither is redundant. The cookie proves same
    // browser; the row proves we issued it and that it has not been spent.
    if (!cookieState || cookieState !== state) {
      return c.text("Sign-in could not be verified. Start again from the dashboard.", 400);
    }
    if (!await consumeOauthState(deps.db, hashState(state))) {
      return c.text("This sign-in link has already been used or has expired.", 400);
    }

    let profile;
    try {
      const accessToken = await exchangeCode(oauth, code, deps.fetch);
      profile = await fetchProfile(accessToken, deps.fetch);
    } catch (err) {
      // The message may name GitHub's complaint but never our client secret,
      // which exchangeCode does not put in its errors.
      const detail = err instanceof GithubOauthError ? err.message : "GitHub sign-in failed";
      return c.text(detail, 502);
    }

    const user = await upsertUserFromGithub(deps.db, profile);
    const { token } = await mintSession(deps.db, user.id);

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1_000,
      ...cookieSecurity(oauth.redirectUri),
    });

    return c.redirect("/dashboard", 302);
  });

  /**
   * POST, not GET. A signout link that worked on GET would be triggered by any
   * page embedding it as an image, and by every link prefetcher.
   */
  routes.post("/logout", async (c) => {
    const deps = c.get("deps");
    const session = await resolveSession(deps.db, getCookie(c, SESSION_COOKIE));
    if (session) await endSession(deps.db, session.sessionId);

    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/", 302);
  });

  return routes;
}
