import { beforeEach, describe, expect, it } from "vitest";
import {
  hashSessionToken,
  mintSession,
  resolveSession,
  endSession,
} from "../../../src/backend/src/auth/session.ts";
import { createDb, migrate, type NodeDb } from "../../../src/backend/src/db/client.node.ts";
import { upsertUserFromGithub, type UserRow } from "../../../src/backend/src/db/repo.ts";

let db: NodeDb;
let user: UserRow;

beforeEach(async () => {
  db = createDb(":memory:");
  migrate(db);
  user = await upsertUserFromGithub(db, { githubId: "1", login: "someone" });
});

describe("session tokens", () => {
  it("resolves a freshly minted session to its user", async () => {
    const { token } = await mintSession(db, user.id);
    expect((await resolveSession(db, token))?.user.id).toBe(user.id);
  });

  it("never stores the plaintext token", async () => {
    const { token } = await mintSession(db, user.id);

    // The stored value is the hash. A dumped sessions table must not be a set
    // of live logins.
    const rows = db.$client.prepare("SELECT token_hash FROM sessions").all() as {
      token_hash: string;
    }[];
    expect(rows[0]?.token_hash).toBe(hashSessionToken(token));
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it("issues a different token every time", async () => {
    const a = await mintSession(db, user.id);
    const b = await mintSession(db, user.id);
    expect(a.token).not.toBe(b.token);
  });

  it.each([
    ["an unknown token", "not-a-real-token"],
    ["an empty string", ""],
  ])("refuses %s", async (_name, token) => {
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("refuses a missing cookie", async () => {
    expect(await resolveSession(db, undefined)).toBeNull();
  });

  it("refuses a session after sign-out", async () => {
    const { token, sessionId } = await mintSession(db, user.id);
    await endSession(db, sessionId);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("refuses an expired session", async () => {
    const { token } = await mintSession(db, user.id, -1_000);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("does not resurrect a revoked session when signing out twice", async () => {
    const { token, sessionId } = await mintSession(db, user.id);
    await endSession(db, sessionId);
    await endSession(db, sessionId);
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("will not let a user be deleted out from under a live session", async () => {
    // `resolveSession` still checks that the user exists, but this is why that
    // check is belt and braces rather than the defence: the database refuses
    // to create the orphan in the first place.
    await mintSession(db, user.id);

    expect(() => db.$client.prepare("DELETE FROM users WHERE id = ?").run(user.id)).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe("users are keyed on the github id, not the login", () => {
  it("updates the existing user when a login is renamed", async () => {
    const renamed = await upsertUserFromGithub(db, { githubId: "1", login: "someone-else" });

    expect(renamed.id).toBe(user.id);
    expect(renamed.login).toBe("someone-else");
  });

  it("creates a separate user when somebody claims the abandoned login", async () => {
    // The dangerous case: if users were matched on login, this person would
    // inherit the original account's projects.
    const impostor = await upsertUserFromGithub(db, { githubId: "2", login: "someone" });

    expect(impostor.id).not.toBe(user.id);
  });
});
