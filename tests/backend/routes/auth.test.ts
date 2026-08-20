import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../helpers/harness.ts";

/**
 * Signing in.
 *
 * Most of these are refusals. The `state` parameter is the only thing stopping
 * an attacker from handing your browser their own authorization code and
 * binding your Adeia session to their GitHub account, so every way of getting
 * past it without one has a test.
 */

const OAUTH = {
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "http://localhost:3000/auth/github/callback",
};

/** Stands in for GitHub: a token exchange and a profile. */
function githubStub(profile: Record<string, unknown> = { id: 4242, login: "someone" }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_stub" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(profile), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/**
 * Pulls one cookie out of a response.
 *
 * A response can carry several `Set-Cookie` headers — the callback clears the
 * state cookie and sets the session in the same reply — and `headers.get`
 * merges them into one string. Picking by name is the only reliable read.
 */
function cookieNamed(res: Response, name: string): string {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return header?.split(";")[0] ?? "";
}

/** Runs the redirect leg and returns the state GitHub would have been sent. */
async function startSignIn(h: Harness): Promise<{ state: string; cookie: string }> {
  const res = await h.app.request("/auth/github");
  const location = res.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  return { state, cookie: cookieNamed(res, "adeia_oauth_state") };
}

let h: Harness;

describe("when no OAuth app is configured", () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it("explains how to set it up instead of offering a broken button", async () => {
    const res = await h.app.request("/auth/github");

    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Sign-in is not set up yet");
  });

  it("shows the dashboard's signed-out page without a login link", async () => {
    const res = await h.app.request("/dashboard");
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("not configured");
    expect(body).not.toContain('href="/auth/github"');
  });
});

describe("starting the handshake", () => {
  beforeEach(async () => {
    h = await createHarness({ oauth: OAUTH });
  });

  it("redirects to GitHub asking only for read:user", async () => {
    const res = await h.app.request("/auth/github");
    const location = new URL(res.headers.get("location") ?? "");

    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("scope")).toBe("read:user");
    // Never a repository scope. An OAuth token that could read code is a token
    // worth stealing, and Adeia has no use for one.
    expect(location.searchParams.get("scope")).not.toContain("repo");
  });

  it("sets an httpOnly state cookie", async () => {
    const res = await h.app.request("/auth/github");
    const cookie = res.headers.get("set-cookie") ?? "";

    expect(cookie).toContain("adeia_oauth_state=");
    expect(cookie).toContain("HttpOnly");
  });

  it("issues a different state each time", async () => {
    const a = await startSignIn(h);
    const b = await startSignIn(h);
    expect(a.state).not.toBe(b.state);
  });
});

describe("the callback refuses anything it cannot verify", () => {
  beforeEach(async () => {
    h = await createHarness({ oauth: OAUTH, fetch: githubStub().fetchImpl });
  });

  it("refuses a callback with no code", async () => {
    const res = await h.app.request("/auth/github/callback?state=x");
    expect(res.status).toBe(400);
  });

  it("refuses a callback with no state", async () => {
    const res = await h.app.request("/auth/github/callback?code=abc");
    expect(res.status).toBe(400);
  });

  it("refuses a state we never issued", async () => {
    const { cookie } = await startSignIn(h);
    const res = await h.app.request("/auth/github/callback?code=abc&state=forged", {
      headers: { cookie },
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("adeia_session=");
  });

  it("refuses a state that arrives without the matching cookie", async () => {
    // This is the login-CSRF case: the attacker starts a handshake in their own
    // browser and feeds the state to a victim. No cookie, no session.
    const { state } = await startSignIn(h);
    const res = await h.app.request(`/auth/github/callback?code=abc&state=${state}`);

    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("adeia_session=");
  });

  it("refuses a state whose cookie belongs to a different handshake", async () => {
    const first = await startSignIn(h);
    const second = await startSignIn(h);
    const res = await h.app.request(`/auth/github/callback?code=abc&state=${first.state}`, {
      headers: { cookie: second.cookie },
    });

    expect(res.status).toBe(400);
  });

  it("refuses a state that has already been spent", async () => {
    const { state, cookie } = await startSignIn(h);
    const url = `/auth/github/callback?code=abc&state=${state}`;

    const first = await h.app.request(url, { headers: { cookie } });
    expect(first.status).toBe(302);

    const replay = await h.app.request(url, { headers: { cookie } });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("already been used");
  });
});

describe("a successful sign-in", () => {
  beforeEach(async () => {
    h = await createHarness({ oauth: OAUTH, fetch: githubStub().fetchImpl });
  });

  it("sets an httpOnly session cookie and lands on the dashboard", async () => {
    const { state, cookie } = await startSignIn(h);
    const res = await h.app.request(`/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("adeia_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("creates the user from the GitHub profile", async () => {
    const { state, cookie } = await startSignIn(h);
    await h.app.request(`/auth/github/callback?code=abc&state=${state}`, { headers: { cookie } });

    const rows = h.db.$client.prepare("SELECT github_id, login FROM users").all() as {
      github_id: string;
      login: string;
    }[];
    expect(rows).toEqual([{ github_id: "4242", login: "someone" }]);
  });

  it("refuses a profile with no id rather than inventing one", async () => {
    h = await createHarness({
      oauth: OAUTH,
      fetch: githubStub({ login: "no-id-here" }).fetchImpl,
    });
    const { state, cookie } = await startSignIn(h);
    const res = await h.app.request(`/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });

    expect(res.status).toBe(502);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("adeia_session=");
  });
});

describe("signing out", () => {
  beforeEach(async () => {
    h = await createHarness({ oauth: OAUTH, fetch: githubStub().fetchImpl });
  });

  it("is POST only, so a prefetch or an embedded image cannot trigger it", async () => {
    const res = await h.app.request("/auth/logout");
    expect(res.status).toBe(404);
  });

  it("kills the session for good", async () => {
    const { state, cookie } = await startSignIn(h);
    const signedIn = await h.app.request(`/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    const session = cookieNamed(signedIn, "adeia_session");

    const before = await h.app.request("/dashboard", { headers: { cookie: session } });
    expect(await before.text()).toContain("Sign out");

    await h.app.request("/auth/logout", { method: "POST", headers: { cookie: session } });

    // The same cookie, replayed after sign-out. Revocation is server-side, so
    // holding the cookie is no longer enough.
    const after = await h.app.request("/dashboard", { headers: { cookie: session } });
    expect(await after.text()).toContain("Continue with GitHub");
  });
});
