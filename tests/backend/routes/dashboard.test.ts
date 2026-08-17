import { beforeEach, describe, expect, it } from "vitest";
import { requestAction } from "../../../src/backend/src/actions/service.ts";
import { mintSession } from "../../../src/backend/src/auth/session.ts";
import {
  STARTER_HTTP_POLICY,
  STARTER_PAYMENT_POLICY,
} from "../../../src/backend/src/routes/dashboard.ts";
import { upsertUserFromGithub, type UserRow } from "../../../src/backend/src/db/repo.ts";
import { DEMO_HTTP_POLICY, DEMO_POLICY } from "../../../scripts/seed.ts";
import { createHarness, httpRequest, paymentRequest, type Harness } from "../../helpers/harness.ts";

let h: Harness;

/** Signs a user in without going through GitHub. */
function signIn(login: string, githubId: string): { user: UserRow; cookie: string } {
  const user = upsertUserFromGithub(h.db, { githubId, login });
  const { token } = mintSession(h.db, user.id);
  return { user, cookie: `adeia_session=${token}` };
}

const get = (path: string, cookie?: string) =>
  h.app.request(path, cookie ? { headers: { cookie } } : undefined);

describe("who can see the dashboard", () => {
  beforeEach(() => {
    h = createHarness({ oauth: { clientId: "c", clientSecret: "s", redirectUri: "http://x/cb" } });
  });

  it("shows the sign-in page to a visitor with no cookie", async () => {
    const res = await get("/dashboard");
    expect(await res.text()).toContain("Continue with GitHub");
  });

  it("shows the sign-in page for a forged cookie", async () => {
    const res = await get("/dashboard", "adeia_session=made-up");
    expect(await res.text()).toContain("Continue with GitHub");
  });

  it("shows the dashboard to a signed-in user", async () => {
    const { cookie } = signIn("someone", "1");
    const body = await (await get("/dashboard", cookie)).text();

    expect(body).toContain("someone");
    expect(body).toContain("Sign out");
  });
});

describe("the first sign-in provisions a project", () => {
  beforeEach(() => {
    h = createHarness();
  });

  it("creates a project, both policies, and shows the key exactly once", async () => {
    const { user, cookie } = signIn("someone", "1");

    const first = await (await get("/dashboard", cookie)).text();
    expect(first).toContain("adeia_sk_");
    expect(first).toContain("only time it is shown");

    const projects = h.db.$client
      .prepare("SELECT id, name, owner_user_id FROM projects WHERE owner_user_id = ?")
      .all(user.id) as { id: string; name: string }[];
    expect(projects).toHaveLength(1);

    const policies = h.db.$client
      .prepare("SELECT action_type FROM policies WHERE project_id = ? ORDER BY action_type")
      .all(projects[0]!.id) as { action_type: string }[];
    expect(policies.map((p) => p.action_type)).toEqual(["http", "payment"]);
  });

  it("never shows the key again on a later visit", async () => {
    const { cookie } = signIn("someone", "1");

    await get("/dashboard", cookie);
    const second = await (await get("/dashboard", cookie)).text();

    expect(second).not.toContain("adeia_sk_");
  });

  it("does not create a second project on every visit", async () => {
    const { user, cookie } = signIn("someone", "1");

    await get("/dashboard", cookie);
    await get("/dashboard", cookie);
    await get("/dashboard", cookie);

    const [row] = h.db.$client
      .prepare("SELECT count(*) AS n FROM projects WHERE owner_user_id = ?")
      .all(user.id) as { n: number }[];
    expect(row!.n).toBe(1);
  });

  it("starts with an empty host allowlist, which denies every outbound call", () => {
    // Guessing which hosts a stranger trusts is not a thing to do for them.
    // Empty denies everything, which is the safe direction to be wrong in.
    expect(STARTER_HTTP_POLICY.config.allowedHosts).toEqual([]);
  });

  it("gives a new user the same limits the documented seed policy uses", () => {
    // A stranger signing up must not quietly land on looser defaults than the
    // ones written down.
    expect(STARTER_PAYMENT_POLICY.maxAmountCents).toBe(DEMO_POLICY.maxAmountCents);
    expect(STARTER_PAYMENT_POLICY.hardMaxAmountCents).toBe(DEMO_POLICY.hardMaxAmountCents);
    expect(STARTER_PAYMENT_POLICY.dailyCapCents).toBe(DEMO_POLICY.dailyCapCents);
    expect(STARTER_HTTP_POLICY.config.approvalMethods).toEqual(
      DEMO_HTTP_POLICY.config.approvalMethods,
    );
    expect(STARTER_HTTP_POLICY.config.classifyMethods).toEqual(
      DEMO_HTTP_POLICY.config.classifyMethods,
    );
  });
});

describe("one user never sees another user's actions", () => {
  beforeEach(() => {
    h = createHarness();
  });

  it("shows each user only their own project", async () => {
    const a = signIn("alice", "1");
    const b = signIn("bob", "2");

    // Provision both.
    await get("/dashboard", a.cookie);
    await get("/dashboard", b.cookie);

    const aBody = await (await get("/dashboard", a.cookie)).text();
    const bBody = await (await get("/dashboard", b.cookie)).text();

    expect(aBody).toContain("alice&#39;s project");
    expect(aBody).not.toContain("bob&#39;s project");
    expect(bBody).toContain("bob&#39;s project");
    expect(bBody).not.toContain("alice&#39;s project");
  });

  it("does not show a seeded, ownerless project to anyone", async () => {
    // `npm run seed` still creates projects nobody owns. "Unowned" must never
    // read as "everyone's".
    const { cookie } = signIn("someone", "1");
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).not.toContain("acct_demo");
  });
});

describe("what the dashboard shows", () => {
  beforeEach(() => {
    h = createHarness({ httpPolicy: {}, verdict: { risk: "low", reason: "Creates an issue." } });
  });

  /** Moves the seeded project under a signed-in user so its actions are visible. */
  function ownProject(login = "someone", githubId = "1") {
    const session = signIn(login, githubId);
    h.db.$client
      .prepare("UPDATE projects SET owner_user_id = ? WHERE id = ?")
      .run(session.user.id, h.projectId);
    return session;
  }

  it("lists an executed action", async () => {
    const { cookie } = ownProject();
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("$25.00");
    expect(body).toContain("ran");
  });

  it("says plainly when a model was what let something run", async () => {
    // The product-integrity assertion. A row that ran because a classifier
    // judged it low risk must never read as one a person approved.
    const { cookie } = ownProject();
    await requestAction(h.deps, h.projectId, httpRequest("POST"));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("A model judged this low risk and let it run");
    expect(body).toContain("Creates an issue.");
  });

  it("marks a flagged action as a model's doing, not a decision already taken", async () => {
    h = createHarness({ httpPolicy: {}, verdict: { risk: "high", reason: "Rewrites a ref." } });
    const { cookie } = ownProject();
    await requestAction(h.deps, h.projectId, httpRequest("POST"));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("A model flagged this for you");
    expect(body).toContain("waiting on you");
  });

  it("adds no model line to an action no classifier touched", async () => {
    const { cookie } = ownProject();
    await requestAction(h.deps, h.projectId, httpRequest("DELETE"));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("waiting on you");
    expect(body).not.toContain("A model judged");
    expect(body).not.toContain("A model flagged");
  });

  it("escapes a classifier reason rather than rendering it as markup", async () => {
    // The reason is model-generated text on its way to a browser.
    h = createHarness({
      httpPolicy: {},
      verdict: { risk: "low", reason: "<img src=x onerror=alert(1)>" },
    });
    const { cookie } = ownProject();
    await requestAction(h.deps, h.projectId, httpRequest("POST"));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x");
  });

  it("never renders an API key belonging to an existing project", async () => {
    const { cookie } = ownProject();
    const body = await (await get("/dashboard", cookie)).text();

    // The project already existed, so nothing was provisioned and no key
    // should appear. Adeia only ever holds the hash anyway.
    expect(body).not.toContain("adeia_sk_");
  });

  it("counts what is waiting separately from what ran", async () => {
    const { cookie } = ownProject();
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    await requestAction(h.deps, h.projectId, paymentRequest(50_000));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("waiting on you");
    expect(body).toContain("ran today");
  });
});
