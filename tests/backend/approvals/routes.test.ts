import { beforeEach, describe, expect, it } from "vitest";
import { requestAction } from "../../../src/backend/src/actions/service.ts";
import { getAction, listAudit } from "../../../src/backend/src/db/repo.ts";
import { APPROVER_EMAIL, createHarness, paymentRequest, type Harness } from "../../helpers/harness.ts";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

/** Requests an over-limit payment and returns the token the "email" carried. */
async function pending(opts: { description?: string } = {}) {
  const action = await requestAction(
    h.deps,
    h.projectId,
    paymentRequest(50_000, { recipient: "acct_contractor", ...opts }),
  );
  const sent = h.sentEmails.at(-1)!;
  return { action, token: sent.token };
}

const get = (token: string) => h.app.request(`/approvals/${token}`);

const decide = (token: string, decision: string) =>
  h.app.request(`/approvals/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ decision }).toString(),
  });

const events = async (actionId: string) => (await listAudit(h.db, actionId)).map((e) => e.event);

describe("GET /approvals/:token — prefetch safety", () => {
  it("renders the page and changes nothing", async () => {
    const { action, token } = await pending();

    const res = await get(token);

    expect(res.status).toBe(200);
    // The property this whole phase exists to protect. Mail scanners, link
    // unfurlers and browser prefetch all issue GETs against emailed links.
    expect((await getAction(h.db, action.id))?.status).toBe("pending_approval");
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("stays inert across repeated prefetches", async () => {
    const { action, token } = await pending();

    for (let i = 0; i < 5; i++) await get(token);

    expect((await getAction(h.db, action.id))?.status).toBe("pending_approval");
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("shows the amount, recipient and the rule that tripped", async () => {
    const { token } = await pending();
    const html = await (await get(token)).text();

    expect(html).toContain("$500.00");
    expect(html).toContain("acct_contractor");
    expect(html).toContain("amount 50000 exceeds per-action limit 5000");
  });

  it("offers both decisions as POST forms, never as links", async () => {
    const { token } = await pending();
    const html = await (await get(token)).text();

    expect(html).toContain('method="POST"');
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
    // A GET form would put the decision in a URL a scanner could follow.
    expect(html).not.toContain('method="GET"');
  });

  it("tells caches and crawlers to leave it alone", async () => {
    const { token } = await pending();
    const res = await get(token);

    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
  });

  it("returns 410 for an unknown token", async () => {
    expect((await get("not-a-token")).status).toBe(410);
  });
});

describe("GET /approvals/:token — expiry", () => {
  it("finalises an action whose token has died", async () => {
    const expiring = await createHarness({ tokenTtlMs: -1 });
    const action = await requestAction(expiring.deps, expiring.projectId, paymentRequest(50_000));
    const { token } = expiring.sentEmails.at(-1)!;

    const res = await expiring.app.request(`/approvals/${token}`);

    expect(res.status).toBe(410);
    // Without this the action sits in pending_approval forever and the SDK's
    // waitForAction polls until its own timeout.
    expect((await getAction(expiring.db, action.id))?.status).toBe("expired");
    expect(expiring.adapter.calls).toHaveLength(0);
  });

  it("expiring is idempotent and never executes anything", async () => {
    const expiring = await createHarness({ tokenTtlMs: -1 });
    const action = await requestAction(expiring.deps, expiring.projectId, paymentRequest(50_000));
    const { token } = expiring.sentEmails.at(-1)!;

    for (let i = 0; i < 3; i++) await expiring.app.request(`/approvals/${token}`);

    const expiries = (await listAudit(expiring.db, action.id)).filter((e) => e.event === "approval.expired");
    expect(expiries).toHaveLength(1);
    expect(expiring.adapter.calls).toHaveLength(0);
  });
});

describe("POST /approvals/:token — approve", () => {
  it("executes the action exactly once", async () => {
    const { action, token } = await pending();

    const res = await decide(token, "approve");

    expect(res.status).toBe(200);
    expect((await getAction(h.db, action.id))?.status).toBe("executed");
    expect(h.adapter.calls).toHaveLength(1);
  });

  it("records the full trail", async () => {
    const { action, token } = await pending();
    await decide(token, "approve");

    expect(await events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.pending_approval",
      "approval.sent",
      "approval.granted",
      "action.executing",
      "action.executed",
    ]);
  });

  it("records who decided", async () => {
    const { action, token } = await pending();
    await decide(token, "approve");

    const granted = (await listAudit(h.db, action.id)).find((e) => e.event === "approval.granted")!;
    expect(JSON.parse(granted.data!)).toEqual({ decidedBy: APPROVER_EMAIL });
  });
});

describe("POST /approvals/:token — deny", () => {
  it("never reaches the adapter", async () => {
    const { action, token } = await pending();

    const res = await decide(token, "deny");

    expect(res.status).toBe(200);
    expect((await getAction(h.db, action.id))?.status).toBe("denied");
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("records the trail without an executing event", async () => {
    const { action, token } = await pending();
    await decide(token, "deny");

    expect(await events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.pending_approval",
      "approval.sent",
      "approval.denied",
    ]);
  });
});

describe("POST /approvals/:token — single use", () => {
  it("returns 410 on the second submit and does not execute twice", async () => {
    const { token } = await pending();

    expect((await decide(token, "approve")).status).toBe(200);
    expect((await decide(token, "approve")).status).toBe(410);

    // Both a double-clicked button and a browser POST-resubmit land here.
    expect(h.adapter.calls).toHaveLength(1);
  });

  it("cannot be flipped from deny to approve", async () => {
    const { action, token } = await pending();

    await decide(token, "deny");
    expect((await decide(token, "approve")).status).toBe(410);

    expect((await getAction(h.db, action.id))?.status).toBe("denied");
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("survives two simultaneous approvals", async () => {
    const { token } = await pending();

    const [a, b] = await Promise.all([decide(token, "approve"), decide(token, "approve")]);

    expect([a.status, b.status].sort()).toEqual([200, 410]);
    expect(h.adapter.calls).toHaveLength(1);
  });

  it("returns 410 for an expired token without executing", async () => {
    const expiring = await createHarness({ tokenTtlMs: -1 });
    const action = await requestAction(expiring.deps, expiring.projectId, paymentRequest(50_000));
    const { token } = expiring.sentEmails.at(-1)!;

    const res = await expiring.app.request(`/approvals/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=approve",
    });

    expect(res.status).toBe(410);
    expect((await getAction(expiring.db, action.id))?.status).toBe("expired");
    expect(expiring.adapter.calls).toHaveLength(0);
  });

  it("rejects an unknown token", async () => {
    expect((await decide("not-a-token", "approve")).status).toBe(410);
    expect(h.adapter.calls).toHaveLength(0);
  });
});

describe("POST /approvals/:token — bad input", () => {
  it.each(["", "maybe", "APPROVE", "approve\n"])(
    "refuses decision=%j without spending the token",
    async (decision) => {
      const { action, token } = await pending();

      expect((await decide(token, decision)).status).toBe(400);
      expect((await getAction(h.db, action.id))?.status).toBe("pending_approval");

      // The token must still work afterwards.
      expect((await decide(token, "approve")).status).toBe(200);
    },
  );

  it("refuses a request with no body at all", async () => {
    const { token } = await pending();

    const res = await h.app.request(`/approvals/${token}`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(h.adapter.calls).toHaveLength(0);
  });
});

describe("escaping", () => {
  it("renders an agent-supplied description inert", async () => {
    const payload = '<script>alert(1)</script>';
    const { token } = await pending({ description: payload });

    const html = await (await get(token)).text();

    // The description comes from an LLM, is influenceable through whatever the
    // agent read, and lands in a human's browser on the way to a payment.
    expect(html).not.toContain(payload);
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a quote-breaking recipient", async () => {
    const action = await requestAction(
      h.deps,
      h.projectId,
      paymentRequest(50_000, { recipient: 'acct" onload="alert(1)' }),
    );
    const { token } = h.sentEmails.at(-1)!;
    const html = await (await get(token)).text();

    expect(action.status).toBe("pending_approval");
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain("&quot;");
  });
});
