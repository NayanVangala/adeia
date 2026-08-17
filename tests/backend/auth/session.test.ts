import { beforeEach, describe, expect, it } from "vitest";
import {
  hashSessionToken,
  mintSession,
  resolveSession,
  endSession,
} from "../../../src/backend/src/auth/session.ts";
import { createDb, migrate, type Db } from "../../../src/backend/src/db/client.ts";
import { upsertUserFromGithub, type UserRow } from "../../../src/backend/src/db/repo.ts";

let db: Db;
let user: UserRow;

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  user = upsertUserFromGithub(db, { githubId: "1", login: "someone" });
});

describe("session tokens", () => {
  it("resolves a freshly minted session to its user", () => {
    const { token } = mintSession(db, user.id);
    expect(resolveSession(db, token)?.user.id).toBe(user.id);
  });

  it("never stores the plaintext token", () => {
    const { token } = mintSession(db, user.id);

    // The stored value is the hash. A dumped sessions table must not be a set
    // of live logins.
    const rows = db.$client.prepare("SELECT token_hash FROM sessions").all() as {
      token_hash: string;
    }[];
    expect(rows[0]?.token_hash).toBe(hashSessionToken(token));
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it("issues a different token every time", () => {
    const a = mintSession(db, user.id);
    const b = mintSession(db, user.id);
    expect(a.token).not.toBe(b.token);
  });

  it.each([
    ["an unknown token", "not-a-real-token"],
    ["an empty string", ""],
  ])("refuses %s", (_name, token) => {
    expect(resolveSession(db, token)).toBeNull();
  });

  it("refuses a missing cookie", () => {
    expect(resolveSession(db, undefined)).toBeNull();
  });

  it("refuses a session after sign-out", () => {
    const { token, sessionId } = mintSession(db, user.id);
    endSession(db, sessionId);
    expect(resolveSession(db, token)).toBeNull();
  });

  it("refuses an expired session", () => {
    const { token } = mintSession(db, user.id, -1_000);
    expect(resolveSession(db, token)).toBeNull();
  });

  it("does not resurrect a revoked session when signing out twice", () => {
    const { token, sessionId } = mintSession(db, user.id);
    endSession(db, sessionId);
    endSession(db, sessionId);
    expect(resolveSession(db, token)).toBeNull();
  });

  it("will not let a user be deleted out from under a live session", () => {
    // `resolveSession` still checks that the user exists, but this is why that
    // check is belt and braces rather than the defence: the database refuses
    // to create the orphan in the first place.
    mintSession(db, user.id);

    expect(() => db.$client.prepare("DELETE FROM users WHERE id = ?").run(user.id)).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe("users are keyed on the github id, not the login", () => {
  it("updates the existing user when a login is renamed", () => {
    const renamed = upsertUserFromGithub(db, { githubId: "1", login: "someone-else" });

    expect(renamed.id).toBe(user.id);
    expect(renamed.login).toBe("someone-else");
  });

  it("creates a separate user when somebody claims the abandoned login", () => {
    // The dangerous case: if users were matched on login, this person would
    // inherit the original account's projects.
    const impostor = upsertUserFromGithub(db, { githubId: "2", login: "someone" });

    expect(impostor.id).not.toBe(user.id);
  });
});
