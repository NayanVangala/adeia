import { beforeEach, describe, expect, it } from "vitest";
import { requestAction } from "../../../src/backend/src/actions/service.ts";
import { hashApiKey } from "../../../src/backend/src/auth/apiKey.ts";
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
async function signIn(login: string, githubId: string): Promise<{ user: UserRow; cookie: string }> {
  const user = await upsertUserFromGithub(h.db, { githubId, login });
  const { token } = await mintSession(h.db, user.id);
  return { user, cookie: `adeia_session=${token}` };
}

const get = (path: string, cookie?: string) =>
  h.app.request(path, cookie ? { headers: { cookie } } : undefined);

describe("who can see the dashboard", () => {
  beforeEach(async () => {
    h = await createHarness({ oauth: { clientId: "c", clientSecret: "s", redirectUri: "http://x/cb" } });
  });

  it("shows the sign-in page to a visitor with no cookie", async () => {
    const res = await get("/dashboard");
    expect(await res.text()).toContain('href="/auth/github"');
  });

  it("shows the sign-in page for a forged cookie", async () => {
    const res = await get("/dashboard", "adeia_session=made-up");
    expect(await res.text()).toContain('href="/auth/github"');
  });

  it("shows the dashboard to a signed-in user", async () => {
    const { cookie } = await signIn("someone", "1");
    const body = await (await get("/dashboard", cookie)).text();

    expect(body).toContain("someone");
    expect(body).toContain("Sign out");
  });
});

describe("the first sign-in provisions a project", () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  it("creates a project, both policies, and shows the key exactly once", async () => {
    const { user, cookie } = await signIn("someone", "1");

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
    const { cookie } = await signIn("someone", "1");

    await get("/dashboard", cookie);
    const second = await (await get("/dashboard", cookie)).text();

    expect(second).not.toContain("adeia_sk_");
  });

  it("does not create a second project on every visit", async () => {
    const { user, cookie } = await signIn("someone", "1");

    await get("/dashboard", cookie);
    await get("/dashboard", cookie);
    await get("/dashboard", cookie);

    const [row] = h.db.$client
      .prepare("SELECT count(*) AS n FROM projects WHERE owner_user_id = ?")
      .all(user.id) as { n: number }[];
    expect(row!.n).toBe(1);
  });

  it("starts with an empty host allowlist, which denies every outbound call", async () => {
    // Guessing which hosts a stranger trusts is not a thing to do for them.
    // Empty denies everything, which is the safe direction to be wrong in.
    expect(STARTER_HTTP_POLICY.config.allowedHosts).toEqual([]);
  });

  it("gives a new user the same limits the documented seed policy uses", async () => {
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
  beforeEach(async () => {
    h = await createHarness();
  });

  it("shows each user only their own project", async () => {
    const a = await signIn("alice", "1");
    const b = await signIn("bob", "2");

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
    const { cookie } = await signIn("someone", "1");
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).not.toContain("acct_demo");
  });
});

describe("what the dashboard shows", () => {
  beforeEach(async () => {
    h = await createHarness({ httpPolicy: {}, verdict: { risk: "low", reason: "Creates an issue." } });
  });

  /** Moves the seeded project under a signed-in user so its actions are visible. */
  async function ownProject(login = "someone", githubId = "1") {
    const session = await signIn(login, githubId);
    h.db.$client
      .prepare("UPDATE projects SET owner_user_id = ? WHERE id = ?")
      .run(session.user.id, h.projectId);
    return session;
  }

  it("lists an executed action", async () => {
    const { cookie } = await ownProject();
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("$25.00");
    expect(body).toContain("ran");
  });

  it("says plainly when a model was what let something run", async () => {
    // The product-integrity assertion. A row that ran because a classifier
    // judged it low risk must never read as one a person approved.
    const { cookie } = await ownProject();
    await requestAction(h.deps, h.projectId, httpRequest("POST"));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("A model judged this low risk and let it run");
    expect(body).toContain("Creates an issue.");
  });

  it("marks a flagged action as a model's doing, not a decision already taken", async () => {
    h = await createHarness({ httpPolicy: {}, verdict: { risk: "high", reason: "Rewrites a ref." } });
    const { cookie } = await ownProject();
    await requestAction(h.deps, h.projectId, httpRequest("POST"));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("A model flagged this for you");
    expect(body).toContain("waiting on you");
  });

  it("adds no model line to an action no classifier touched", async () => {
    const { cookie } = await ownProject();
    await requestAction(h.deps, h.projectId, httpRequest("DELETE"));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("waiting on you");
    expect(body).not.toContain("A model judged");
    expect(body).not.toContain("A model flagged");
  });

  it("escapes a classifier reason rather than rendering it as markup", async () => {
    // The reason is model-generated text on its way to a browser.
    h = await createHarness({
      httpPolicy: {},
      verdict: { risk: "low", reason: "<img src=x onerror=alert(1)>" },
    });
    const { cookie } = await ownProject();
    await requestAction(h.deps, h.projectId, httpRequest("POST"));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x");
  });

  it("never renders an API key belonging to an existing project", async () => {
    const { cookie } = await ownProject();
    const body = await (await get("/dashboard", cookie)).text();

    // The project already existed, so nothing was provisioned and no key
    // should appear. Adeia only ever holds the hash anyway.
    expect(body).not.toContain("adeia_sk_");
  });

  it("counts what is waiting separately from what ran", async () => {
    const { cookie } = await ownProject();
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    await requestAction(h.deps, h.projectId, paymentRequest(50_000));

    const body = await (await get("/dashboard", cookie)).text();
    expect(body).toContain("waiting on you");
    expect(body).toContain("ran today");
  });
});

describe("rotating the API key", () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  /** Signs in and provisions, returning the cookie and the project id. */
  async function established() {
    const session = await signIn("someone", "1");
    await get("/dashboard", session.cookie);
    const [row] = h.db.$client
      .prepare("SELECT id, api_key_hash FROM projects WHERE owner_user_id = ?")
      .all(session.user.id) as { id: string; api_key_hash: string }[];
    return { ...session, projectId: row!.id, hashBefore: row!.api_key_hash };
  }

  const rotate = (cookie: string, csrf: string) =>
    h.app.request("/dashboard/key", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }).toString(),
    });

  /** Reads the CSRF token the page embedded in its forms. */
  async function csrfFrom(cookie: string): Promise<string> {
    const body = await (await get("/dashboard", cookie)).text();
    return /name="csrf" value="([a-f0-9]+)"/.exec(body)?.[1] ?? "";
  }

  it("issues a new key and shows it exactly once", async () => {
    const s = await established();
    const csrf = await csrfFrom(s.cookie);

    const res = await rotate(s.cookie, csrf);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("adeia_sk_");

    // Gone on the next load, because only the hash was kept.
    const next = await (await get("/dashboard", s.cookie)).text();
    expect(next).not.toContain("adeia_sk_");
  });

  it("stores only the hash, never the key itself", async () => {
    const s = await established();
    const csrf = await csrfFrom(s.cookie);

    const body = await (await rotate(s.cookie, csrf)).text();
    const shown = /adeia_sk_[A-Za-z0-9_-]+/.exec(body)?.[0] ?? "";
    expect(shown).not.toBe("");

    const [row] = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE id = ?")
      .all(s.projectId) as { api_key_hash: string }[];
    expect(row!.api_key_hash).not.toBe(shown);
    expect(row!.api_key_hash).toBe(hashApiKey(shown));
  });

  it("kills the old key immediately", async () => {
    const s = await established();
    const csrf = await csrfFrom(s.cookie);

    await rotate(s.cookie, csrf);

    const [row] = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE id = ?")
      .all(s.projectId) as { api_key_hash: string }[];
    expect(row!.api_key_hash).not.toBe(s.hashBefore);
  });

  it("never puts the key in a redirect URL", async () => {
    // A redirect would carry the secret into browser history, the referer
    // header, and every log between here and the user.
    const s = await established();
    const csrf = await csrfFrom(s.cookie);

    const res = await rotate(s.cookie, csrf);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses without a CSRF token", async () => {
    const s = await established();

    const res = await rotate(s.cookie, "");
    expect(res.status).toBe(403);

    const [row] = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE id = ?")
      .all(s.projectId) as { api_key_hash: string }[];
    expect(row!.api_key_hash).toBe(s.hashBefore);
  });

  it("refuses a CSRF token belonging to a different session", async () => {
    const mine = await established();
    const theirs = await signIn("someone-else", "2");
    await get("/dashboard", theirs.cookie);
    const theirCsrf = await csrfFrom(theirs.cookie);

    const res = await rotate(mine.cookie, theirCsrf);
    expect(res.status).toBe(403);

    const [row] = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE id = ?")
      .all(mine.projectId) as { api_key_hash: string }[];
    expect(row!.api_key_hash).toBe(mine.hashBefore);
  });

  it("refuses a signed-out request", async () => {
    const s = await established();

    const res = await rotate("adeia_session=forged", "anything");
    expect(res.status).toBe(302);

    const [row] = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE id = ?")
      .all(s.projectId) as { api_key_hash: string }[];
    expect(row!.api_key_hash).toBe(s.hashBefore);
  });

  it("rotates only the caller's own project", async () => {
    const mine = await established();
    const theirs = await signIn("someone-else", "2");
    await get("/dashboard", theirs.cookie);
    const [before] = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE owner_user_id = ?")
      .all(theirs.user.id) as { api_key_hash: string }[];

    await rotate(mine.cookie, await csrfFrom(mine.cookie));

    const [after] = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE owner_user_id = ?")
      .all(theirs.user.id) as { api_key_hash: string }[];
    expect(after!.api_key_hash).toBe(before!.api_key_hash);
  });

  it("produces a key that actually authenticates against the API", async () => {
    // End to end: the thing the dashboard hands you must work as a bearer
    // token, or the whole flow is decorative.
    const s = await established();
    const body = await (await rotate(s.cookie, await csrfFrom(s.cookie))).text();
    const key = /adeia_sk_[A-Za-z0-9_-]+/.exec(body)?.[0] ?? "";

    const ok = await h.app.request("/v1/audit", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(ok.status).toBe(200);
  });
});

describe("more than one project", () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  /** Signs in, provisioning the first project, and reads back its CSRF token. */
  async function established(login: string, ghId: string) {
    const session = await signIn(login, ghId);
    const page = await (await get("/dashboard", session.cookie)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const rows = h.db.$client
      .prepare("SELECT id FROM projects WHERE owner_user_id = ?")
      .all(session.user.id) as { id: string }[];
    return { ...session, csrf, projectId: rows[0]!.id };
  }

  const post = (path: string, cookie: string, body: Record<string, string>) =>
    h.app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });

  const projectsOf = (userId: string) =>
    h.db.$client
      .prepare("SELECT id, name FROM projects WHERE owner_user_id = ? ORDER BY rowid")
      .all(userId) as { id: string; name: string }[];

  it("creates a second project with its own key and both starter policies", async () => {
    const me = await established("me", "1");
    const res = await post("/dashboard/project/new", me.cookie, {
      csrf: me.csrf,
      name: "billing",
    });

    expect(res.status).toBe(200);
    const owned = projectsOf(me.user.id);
    expect(owned).toHaveLength(2);
    expect(owned[1]!.name).toBe("billing");

    // Its own key, not a copy of the first one.
    const hashes = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE owner_user_id = ?")
      .all(me.user.id) as { api_key_hash: string }[];
    expect(new Set(hashes.map((r) => r.api_key_hash)).size).toBe(2);

    // Both starter policies, so a second project is not a lesser one.
    const policies = h.db.$client
      .prepare("SELECT action_type FROM policies WHERE project_id = ?")
      .all(owned[1]!.id) as { action_type: string }[];
    expect(policies.map((p) => p.action_type).sort()).toEqual(["http", "payment"]);
  });

  it("shows the new key exactly once, on the page that created it", async () => {
    const me = await established("me", "1");
    const body = await (
      await post("/dashboard/project/new", me.cookie, { csrf: me.csrf, name: "billing" })
    ).text();
    expect(body).toMatch(/adeia_sk_[A-Za-z0-9_-]+/);

    // And never again on a later visit.
    const later = await (await get("/dashboard", me.cookie)).text();
    expect(later).not.toMatch(/adeia_sk_[A-Za-z0-9_-]+/);
  });

  it("renames a project", async () => {
    const me = await established("me", "1");
    await post("/dashboard/project/rename", me.cookie, {
      csrf: me.csrf,
      projectId: me.projectId,
      name: "renamed",
    });
    expect(projectsOf(me.user.id)[0]!.name).toBe("renamed");
  });

  it("ignores an empty name rather than leaving a project unnamed", async () => {
    const me = await established("me", "1");
    const before = projectsOf(me.user.id)[0]!.name;
    await post("/dashboard/project/rename", me.cookie, {
      csrf: me.csrf,
      projectId: me.projectId,
      name: "   ",
    });
    expect(projectsOf(me.user.id)[0]!.name).toBe(before);
  });

  it("refuses a rename without a CSRF token", async () => {
    const me = await established("me", "1");
    const before = projectsOf(me.user.id)[0]!.name;
    const res = await post("/dashboard/project/rename", me.cookie, {
      projectId: me.projectId,
      name: "hijacked",
    });
    expect(res.status).toBe(403);
    expect(projectsOf(me.user.id)[0]!.name).toBe(before);
  });

  it("refuses a create without a CSRF token", async () => {
    const me = await established("me", "1");
    const res = await post("/dashboard/project/new", me.cookie, { name: "hijacked" });
    expect(res.status).toBe(403);
    expect(projectsOf(me.user.id)).toHaveLength(1);
  });

  it("cannot rename a project belonging to somebody else", async () => {
    const me = await established("me", "1");
    const you = await established("you", "2");
    const yoursBefore = projectsOf(you.user.id)[0]!.name;

    await post("/dashboard/project/rename", me.cookie, {
      csrf: me.csrf,
      projectId: you.projectId,
      name: "taken",
    });

    // Untouched. The selector only ever finds ids inside the caller's own list,
    // so the id falls through to the caller's first project instead.
    expect(projectsOf(you.user.id)[0]!.name).toBe(yoursBefore);
    expect(projectsOf(me.user.id)[0]!.name).toBe("taken");
  });

  it("cannot open somebody else's project with ?p=", async () => {
    const me = await established("me", "1");
    const you = await established("you", "2");
    await post("/dashboard/project/rename", you.cookie, {
      csrf: you.csrf,
      projectId: you.projectId,
      name: "your-secret-project",
    });

    const page = await (await get(`/dashboard?p=${you.projectId}`, me.cookie)).text();
    expect(page).not.toContain("your-secret-project");
    expect(page).not.toContain(you.projectId);
  });

  it("opens on the project you last looked at", async () => {
    const me = await established("me", "1");
    await post("/dashboard/project/new", me.cookie, { csrf: me.csrf, name: "second" });
    const second = projectsOf(me.user.id)[1]!;

    // Visit it explicitly; the response should hand back a cookie naming it.
    const visited = await get(`/dashboard?p=${second.id}`, me.cookie);
    const setCookie = visited.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`adeia_project=${second.id}`);

    // A later visit with no ?p= lands on it rather than the first project.
    const later = await get("/dashboard", `${me.cookie}; adeia_project=${second.id}`);
    expect(await later.text()).toContain("second");
  });

  it("ignores a project cookie naming somebody else's project", async () => {
    const me = await established("me", "1");
    const you = await established("you", "2");
    await post("/dashboard/project/rename", you.cookie, {
      csrf: you.csrf,
      projectId: you.projectId,
      name: "not-yours",
    });

    // The cookie is a hint, never an authority: it still passes through the
    // owner-scoped selector, so a forged one selects nothing.
    const page = await (await get("/dashboard", `${me.cookie}; adeia_project=${you.projectId}`)).text();
    expect(page).not.toContain("not-yours");
    expect(page).not.toContain(you.projectId);
  });

  it("edits the allowlist of the project being viewed, not the first one", async () => {
    // The forms carry projectId for a reason: without it the route falls back
    // to the caller's first project, so editing hosts while looking at a
    // second one silently edits the first, with nothing to notice.
    const me = await established("me", "1");
    await post("/dashboard/project/new", me.cookie, { csrf: me.csrf, name: "second" });
    const owned = projectsOf(me.user.id);
    const second = owned[1]!;

    await post("/dashboard/policy/hosts", me.cookie, {
      csrf: me.csrf,
      projectId: second.id,
      add: "api.github.com",
    });

    const hostsOf = (id: string) => {
      const row = h.db.$client
        .prepare("SELECT config FROM policies WHERE project_id = ? AND action_type = 'http'")
        .get(id) as { config: string } | undefined;
      return row ? (JSON.parse(row.config).allowedHosts as string[]) : [];
    };

    expect(hostsOf(second.id)).toContain("api.github.com");
    expect(hostsOf(owned[0]!.id)).not.toContain("api.github.com");
  });

  it("cannot rotate the key on somebody else's project", async () => {
    const me = await established("me", "1");
    const you = await established("you", "2");
    const before = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE id = ?")
      .get(you.projectId) as { api_key_hash: string };

    await post("/dashboard/key", me.cookie, { csrf: me.csrf, projectId: you.projectId });

    const after = h.db.$client
      .prepare("SELECT api_key_hash FROM projects WHERE id = ?")
      .get(you.projectId) as { api_key_hash: string };
    expect(after.api_key_hash).toBe(before.api_key_hash);
  });
});

describe("archiving a project", () => {
  beforeEach(async () => {
    h = await createHarness();
  });

  async function established(login: string, ghId: string) {
    const session = await signIn(login, ghId);
    const page = await (await get("/dashboard", session.cookie)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const rows = h.db.$client
      .prepare("SELECT id FROM projects WHERE owner_user_id = ?")
      .all(session.user.id) as { id: string }[];
    return { ...session, csrf, projectId: rows[0]!.id };
  }

  const post = (path: string, cookie: string, body: Record<string, string>) =>
    h.app.request(path, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });

  /** Creates a second project and returns its id and freshly shown key. */
  async function second(cookie: string, csrf: string) {
    const body = await (await post("/dashboard/project/new", cookie, { csrf, name: "second" })).text();
    const key = /adeia_sk_[A-Za-z0-9_-]+/.exec(body)?.[0] ?? "";
    const row = h.db.$client
      .prepare("SELECT id FROM projects WHERE name = ?")
      .get("second") as { id: string };
    return { id: row.id, key };
  }

  const callApi = (key: string) =>
    h.app.request("/v1/audit", { headers: { authorization: `Bearer ${key}` } });

  it("stops the key authenticating, which is the point of it", async () => {
    const me = await established("me", "1");
    const proj = await second(me.cookie, me.csrf);

    expect((await callApi(proj.key)).status).toBe(200);

    await post("/dashboard/project/archive", me.cookie, { csrf: me.csrf, projectId: proj.id });

    expect((await callApi(proj.key)).status).toBe(401);
  });

  it("restores the key when the project is restored", async () => {
    const me = await established("me", "1");
    const proj = await second(me.cookie, me.csrf);

    await post("/dashboard/project/archive", me.cookie, { csrf: me.csrf, projectId: proj.id });
    expect((await callApi(proj.key)).status).toBe(401);

    await post("/dashboard/project/archive", me.cookie, {
      csrf: me.csrf,
      projectId: proj.id,
      restore: "1",
    });
    expect((await callApi(proj.key)).status).toBe(200);
  });

  it("keeps every action the archived project already took", async () => {
    const me = await established("me", "1");
    const proj = await second(me.cookie, me.csrf);
    await requestAction(h.deps, proj.id, paymentRequest(1000));

    const before = h.db.$client
      .prepare("SELECT COUNT(*) AS n FROM actions WHERE project_id = ?")
      .get(proj.id) as { n: number };

    await post("/dashboard/project/archive", me.cookie, { csrf: me.csrf, projectId: proj.id });

    const after = h.db.$client
      .prepare("SELECT COUNT(*) AS n FROM actions WHERE project_id = ?")
      .get(proj.id) as { n: number };
    expect(after.n).toBe(before.n);
    expect(after.n).toBeGreaterThan(0);
  });

  it("refuses to archive the last live project, so nobody locks themselves out", async () => {
    const me = await established("me", "1");
    await post("/dashboard/project/archive", me.cookie, { csrf: me.csrf, projectId: me.projectId });

    const row = h.db.$client
      .prepare("SELECT archived_at FROM projects WHERE id = ?")
      .get(me.projectId) as { archived_at: string | null };
    expect(row.archived_at).toBeNull();
  });

  it("cannot archive somebody else's project", async () => {
    const me = await established("me", "1");
    const you = await established("you", "2");
    // Give the other account a second project so the last-live guard is not
    // what stops this — the ownership boundary has to be what stops it.
    const theirs = await second(you.cookie, you.csrf);

    await post("/dashboard/project/archive", me.cookie, { csrf: me.csrf, projectId: theirs.id });

    const row = h.db.$client
      .prepare("SELECT archived_at FROM projects WHERE id = ?")
      .get(theirs.id) as { archived_at: string | null };
    expect(row.archived_at).toBeNull();
    expect((await callApi(theirs.key)).status).toBe(200);
  });

  it("refuses without a CSRF token", async () => {
    const me = await established("me", "1");
    const proj = await second(me.cookie, me.csrf);
    const res = await post("/dashboard/project/archive", me.cookie, { projectId: proj.id });
    expect(res.status).toBe(403);
    expect((await callApi(proj.key)).status).toBe(200);
  });
});
