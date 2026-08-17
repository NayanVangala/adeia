import { beforeEach, describe, expect, it } from "vitest";
import { requestAction } from "../../../src/backend/src/actions/service.ts";
import { csrfTokenFor, hashSessionToken, mintSession } from "../../../src/backend/src/auth/session.ts";
import { getPolicy, toPolicy, upsertUserFromGithub } from "../../../src/backend/src/db/repo.ts";
import { normaliseHost } from "../../../src/backend/src/routes/dashboard.ts";
import { createHarness, httpRequest, type Harness } from "../../helpers/harness.ts";

let h: Harness;

interface Signed {
  cookie: string;
  csrf: string;
  userId: string;
}

function signIn(login: string, githubId: string): Signed {
  const user = upsertUserFromGithub(h.db, { githubId, login });
  const { token } = mintSession(h.db, user.id);
  return {
    cookie: `adeia_session=${token}`,
    csrf: csrfTokenFor(hashSessionToken(token)),
    userId: user.id,
  };
}

function own(s: Signed): void {
  h.db.$client
    .prepare("UPDATE projects SET owner_user_id = ? WHERE id = ?")
    .run(s.userId, h.projectId);
}

async function editHosts(body: Record<string, string>, cookie?: string): Promise<Response> {
  return h.app.request("/dashboard/policy/hosts", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });
}

function hosts(): string[] {
  const row = getPolicy(h.db, h.projectId, "http")!;
  const policy = toPolicy(row);
  return policy.actionType === "http" ? policy.allowedHosts : [];
}

describe("normaliseHost", () => {
  it.each([
    ["api.github.com", "api.github.com"],
    ["  API.GitHub.com  ", "api.github.com"],
    ["https://api.github.com/repos/x/y", "api.github.com"],
    ["https://api.cloudflare.com", "api.cloudflare.com"],
  ])("accepts %s", (input, expected) => {
    expect(normaliseHost(input)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["a bare word with no dot", "localhost"],
    ["a wildcard", "*.github.com"],
    ["a path on a bare host", "api.github.com/repos"],
    ["spaces", "api github com"],
    ["a query string", "api.github.com?x=1"],
  ])("rejects %s", (_name, input) => {
    expect(normaliseHost(input)).toBeNull();
  });
});

describe("editing the allowlist", () => {
  beforeEach(() => {
    h = createHarness({ httpPolicy: { allowedHosts: [] } });
  });

  it("starts empty, which denies every call", async () => {
    const s = signIn("alice", "1");
    own(s);

    expect(hosts()).toEqual([]);

    const action = await requestAction(h.deps, h.projectId, httpRequest("GET"));
    expect(action.status).toBe("denied");
  });

  it("adds a host, and the engine then allows it", async () => {
    const s = signIn("alice", "1");
    own(s);

    await editHosts({ csrf: s.csrf, add: "api.github.com" }, s.cookie);
    expect(hosts()).toEqual(["api.github.com"]);

    // The point of the whole feature: the fence actually moved.
    const action = await requestAction(h.deps, h.projectId, httpRequest("GET"));
    expect(action.status).toBe("executed");
  });

  it("removes a host, and the engine then denies it", async () => {
    const s = signIn("alice", "1");
    own(s);

    await editHosts({ csrf: s.csrf, add: "api.github.com" }, s.cookie);
    await editHosts({ csrf: s.csrf, remove: "api.github.com" }, s.cookie);

    expect(hosts()).toEqual([]);
    const action = await requestAction(h.deps, h.projectId, httpRequest("GET"));
    expect(action.status).toBe("denied");
  });

  it("does not add the same host twice", async () => {
    const s = signIn("alice", "1");
    own(s);

    await editHosts({ csrf: s.csrf, add: "api.github.com" }, s.cookie);
    await editHosts({ csrf: s.csrf, add: "API.GITHUB.COM" }, s.cookie);

    expect(hosts()).toEqual(["api.github.com"]);
  });

  it("leaves the rest of the policy untouched", async () => {
    const s = signIn("alice", "1");
    own(s);

    await editHosts({ csrf: s.csrf, add: "api.github.com" }, s.cookie);

    const policy = toPolicy(getPolicy(h.db, h.projectId, "http")!);
    expect(policy.actionType).toBe("http");
    if (policy.actionType !== "http") return;
    expect(policy.approvalMethods).toEqual(["DELETE"]);
    expect(policy.classifyMethods).toEqual(["POST", "PUT", "PATCH"]);
    expect(policy.maxCallsPerDay).toBe(100);
  });
});

describe("what the policy editor refuses", () => {
  beforeEach(() => {
    h = createHarness({ httpPolicy: { allowedHosts: [] } });
  });

  it("refuses a private address, and says why", async () => {
    const s = signIn("alice", "1");
    own(s);

    const res = await editHosts({ csrf: s.csrf, add: "169.254.169.254" }, s.cookie);

    expect(res.headers.get("location")).toContain("policy=private");
    expect(hosts()).toEqual([]);
  });

  it.each(["localhost", "127.0.0.1", "10.0.0.1", "192.168.1.1"])(
    "refuses %s",
    async (host) => {
      const s = signIn("alice", "1");
      own(s);

      await editHosts({ csrf: s.csrf, add: host }, s.cookie);
      expect(hosts()).toEqual([]);
    },
  );

  it("refuses something that is not a hostname", async () => {
    const s = signIn("alice", "1");
    own(s);

    const res = await editHosts({ csrf: s.csrf, add: "*.github.com" }, s.cookie);

    expect(res.headers.get("location")).toContain("policy=invalid");
    expect(hosts()).toEqual([]);
  });

  it("refuses a missing CSRF token", async () => {
    const s = signIn("alice", "1");
    own(s);

    const res = await editHosts({ add: "api.github.com" }, s.cookie);

    expect(res.status).toBe(403);
    expect(hosts()).toEqual([]);
  });

  it("refuses a request with no session", async () => {
    const s = signIn("alice", "1");
    own(s);

    await editHosts({ csrf: s.csrf, add: "api.github.com" });
    expect(hosts()).toEqual([]);
  });

  it("never edits another user's policy", async () => {
    const alice = signIn("alice", "1");
    const bob = signIn("bob", "2");
    own(alice);

    // Bob is signed in with a valid token of his own, but owns no project, so
    // there is nothing for this to touch.
    await editHosts({ csrf: bob.csrf, add: "evil.example.com" }, bob.cookie);

    expect(hosts()).toEqual([]);
  });
});

describe("the dashboard shows the allowlist", () => {
  beforeEach(() => {
    h = createHarness({ httpPolicy: { allowedHosts: [] } });
  });

  it("warns when nothing is allowed yet", async () => {
    const s = signIn("alice", "1");
    own(s);

    const body = await (await h.app.request("/dashboard", { headers: { cookie: s.cookie } })).text();

    expect(body).toContain("No hosts allowed yet");
    expect(body).toContain("every outbound call is refused");
  });

  it("lists the hosts once they exist", async () => {
    const s = signIn("alice", "1");
    own(s);
    await editHosts({ csrf: s.csrf, add: "api.github.com" }, s.cookie);

    const body = await (await h.app.request("/dashboard", { headers: { cookie: s.cookie } })).text();

    expect(body).toContain("api.github.com");
    expect(body).toContain(">Remove<");
  });
});
