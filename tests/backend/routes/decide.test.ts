import { beforeEach, describe, expect, it } from "vitest";
import { requestAction } from "../../../src/backend/src/actions/service.ts";
import { csrfTokenFor, hashSessionToken, mintSession } from "../../../src/backend/src/auth/session.ts";
import { getAction, upsertUserFromGithub } from "../../../src/backend/src/db/repo.ts";
import { createHarness, httpRequest, paymentRequest, type Harness } from "../../helpers/harness.ts";

/**
 * Approving from the dashboard.
 *
 * The assertion that matters most is the cross-tenant one. An action id is not
 * a secret — it comes back in API responses and appears in logs — so if the
 * route trusted the id alone, any signed-in stranger could release somebody
 * else's payment by pasting it into a form.
 */

let h: Harness;

interface Signed {
  cookie: string;
  csrf: string;
  userId: string;
}

async function signIn(login: string, githubId: string): Promise<Signed> {
  const user = await upsertUserFromGithub(h.db, { githubId, login });
  const { token } = await mintSession(h.db, user.id);
  return {
    cookie: `adeia_session=${token}`,
    csrf: csrfTokenFor(hashSessionToken(token)),
    userId: user.id,
  };
}

/** Puts the harness's seeded project under a signed-in user. */
function own(s: Signed): void {
  h.db.$client
    .prepare("UPDATE projects SET owner_user_id = ? WHERE id = ?")
    .run(s.userId, h.projectId);
}

async function decide(
  actionId: string,
  body: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  return h.app.request(`/dashboard/actions/${actionId}/decision`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

/** A payment over the per-action limit, so it lands in pending_approval. */
async function pending(): Promise<string> {
  const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
  expect(action.status).toBe("pending_approval");
  return action.id;
}

beforeEach(async () => {
  h = await createHarness({ httpPolicy: {} });
});

describe("approving from the dashboard", () => {
  it("runs the action and records who decided", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    const res = await decide(id, { csrf: s.csrf, decision: "approve" }, s.cookie);

    expect(res.status).toBe(302);
    expect((await getAction(h.db, id))?.status).toBe("executed");
    expect(h.adapter.calls).toHaveLength(1);
  });

  it("denies without ever reaching the adapter", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    await decide(id, { csrf: s.csrf, decision: "deny" }, s.cookie);

    expect((await getAction(h.db, id))?.status).toBe("denied");
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("names the GitHub account in the audit trail, not just 'a human'", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    await decide(id, { csrf: s.csrf, decision: "approve" }, s.cookie);

    const rows = h.db.$client
      .prepare("SELECT data FROM audit_events WHERE action_id = ? AND event = 'approval.granted'")
      .all(id) as { data: string }[];
    expect(JSON.parse(rows[0]!.data)).toMatchObject({ decidedBy: "github:alice" });
  });

  it("survives a double-submitted form without running twice", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    await decide(id, { csrf: s.csrf, decision: "approve" }, s.cookie);
    const again = await decide(id, { csrf: s.csrf, decision: "approve" }, s.cookie);

    expect(again.headers.get("location")).toContain("already");
    expect(h.adapter.calls).toHaveLength(1);
  });
});

describe("what the decision route refuses", () => {
  it("refuses a request with no session", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    const res = await decide(id, { csrf: s.csrf, decision: "approve" });

    expect(res.status).toBe(302);
    expect((await getAction(h.db, id))?.status).toBe("pending_approval");
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("refuses a missing CSRF token", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    const res = await decide(id, { decision: "approve" }, s.cookie);

    expect(res.status).toBe(403);
    expect((await getAction(h.db, id))?.status).toBe("pending_approval");
  });

  it("refuses a forged CSRF token", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    const res = await decide(id, { csrf: "not-the-token", decision: "approve" }, s.cookie);

    expect(res.status).toBe(403);
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("refuses another session's CSRF token", async () => {
    const alice = await signIn("alice", "1");
    const bob = await signIn("bob", "2");
    own(alice);
    const id = await pending();

    const res = await decide(id, { csrf: bob.csrf, decision: "approve" }, alice.cookie);

    expect(res.status).toBe(403);
    expect((await getAction(h.db, id))?.status).toBe("pending_approval");
  });

  it("will not let one user decide another user's action", async () => {
    // The whole reason the ownership check exists. Bob is a real, signed-in
    // user with a valid CSRF token of his own — everything is legitimate
    // except that the action is not his.
    const alice = await signIn("alice", "1");
    const bob = await signIn("bob", "2");
    own(alice);
    const id = await pending();

    const res = await decide(id, { csrf: bob.csrf, decision: "approve" }, bob.cookie);

    expect(res.status).toBe(404);
    expect((await getAction(h.db, id))?.status).toBe("pending_approval");
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("says 404, not 403, so probing ids reveals nothing", async () => {
    const bob = await signIn("bob", "2");
    const alice = await signIn("alice", "1");
    own(alice);
    const real = await pending();

    const known = await decide(real, { csrf: bob.csrf, decision: "approve" }, bob.cookie);
    const invented = await decide("act_doesnotexist", { csrf: bob.csrf, decision: "approve" }, bob.cookie);

    // An id that exists and one that does not are indistinguishable.
    expect(known.status).toBe(invented.status);
  });

  it("refuses a decision value it does not recognise", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    const res = await decide(id, { csrf: s.csrf, decision: "maybe" }, s.cookie);

    expect(res.status).toBe(400);
    expect((await getAction(h.db, id))?.status).toBe("pending_approval");
  });

  it("cannot be triggered by a GET", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    const res = await h.app.request(`/dashboard/actions/${id}/decision?decision=approve`, {
      headers: { cookie: s.cookie },
    });

    expect(res.status).toBe(404);
    expect((await getAction(h.db, id))?.status).toBe("pending_approval");
  });
});

describe("the dashboard renders the buttons", () => {
  it("puts approve and deny on a waiting action, with a CSRF field", async () => {
    const s = await signIn("alice", "1");
    own(s);
    const id = await pending();

    const body = await (await h.app.request("/dashboard", { headers: { cookie: s.cookie } })).text();

    expect(body).toContain(`/dashboard/actions/${id}/decision`);
    expect(body).toContain(`value="${s.csrf}"`);
    expect(body).toContain(">Approve<");
    expect(body).toContain(">Deny<");
  });

  it("puts no buttons on an action already settled", async () => {
    const s = await signIn("alice", "1");
    own(s);
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const body = await (await h.app.request("/dashboard", { headers: { cookie: s.cookie } })).text();

    expect(body).not.toContain("/decision");
  });

  it("offers the same buttons for a classifier-flagged call", async () => {
    h = await createHarness({ httpPolicy: {}, verdict: { risk: "high", reason: "Rewrites a ref." } });
    const s = await signIn("alice", "1");
    own(s);
    const action = await requestAction(h.deps, h.projectId, httpRequest("POST"));

    const body = await (await h.app.request("/dashboard", { headers: { cookie: s.cookie } })).text();

    expect(body).toContain(`/dashboard/actions/${action.id}/decision`);
    expect(body).toContain("A model flagged this for you");
  });
});
