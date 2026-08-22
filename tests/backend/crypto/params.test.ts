import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hasSecrets, openParams, parseKey, sealParams } from "../../../src/backend/src/crypto/params.ts";

const key = randomBytes(32);

describe("the params key", () => {
  it("accepts hex and base64", () => {
    expect(parseKey(randomBytes(32).toString("hex"))).toHaveLength(32);
    expect(parseKey(randomBytes(32).toString("base64"))).toHaveLength(32);
  });

  it("refuses a key that is not 32 bytes rather than padding it", () => {
    // A key silently stretched from a short string is a key whose strength
    // nobody can state.
    expect(() => parseKey("hunter2")).toThrow(/32 bytes/);
  });
});

describe("sealing params", () => {
  const params = {
    method: "POST",
    url: "https://api.github.com/repos/x/y/issues",
    headers: { authorization: "Bearer ghp_secret", accept: "application/json" },
    body: { title: "hello" },
  };

  it("encrypts secret-looking values and leaves the rest readable", () => {
    const sealed = sealParams(key, params) as typeof params;

    // The approval page has to show a person what they are approving.
    expect(sealed.method).toBe("POST");
    expect(sealed.url).toBe(params.url);
    expect(sealed.body).toEqual({ title: "hello" });
    expect(sealed.headers.accept).toBe("application/json");

    // The credential is not present in any form.
    expect(JSON.stringify(sealed)).not.toContain("ghp_secret");
  });

  it("round-trips back to exactly what went in", () => {
    expect(openParams(key, sealParams(key, params))).toEqual(params);
  });

  it("uses a fresh IV, so the same secret seals differently each time", () => {
    // Reusing an IV under one key is the mistake that breaks GCM outright.
    const a = JSON.stringify(sealParams(key, params));
    const b = JSON.stringify(sealParams(key, params));
    expect(a).not.toBe(b);
    expect(openParams(key, JSON.parse(a))).toEqual(openParams(key, JSON.parse(b)));
  });

  it("refuses to open a value that was tampered with", () => {
    const sealed = sealParams(key, params) as {
      headers: { authorization: { ct: string } };
    };
    sealed.headers.authorization.ct = Buffer.from("something else").toString("base64");
    expect(() => openParams(key, sealed)).toThrow();
  });

  it("refuses to open under a different key", () => {
    expect(() => openParams(randomBytes(32), sealParams(key, params))).toThrow();
  });

  it("passes through params written before this existed", () => {
    // A deployment upgrading mid-flight must still be able to read its rows.
    expect(openParams(key, { method: "GET", url: "https://x" })).toEqual({
      method: "GET",
      url: "https://x",
    });
  });

  it("leaves a non-string under a secret-looking name alone", () => {
    // A number called `token` is not a credential, and encrypting it would
    // change its type on the way back out.
    const sealed = sealParams(key, { token: 42 }) as { token: number };
    expect(sealed.token).toBe(42);
  });

  it("finds secrets at depth", () => {
    expect(hasSecrets({ headers: { authorization: "x" } })).toBe(true);
    expect(hasSecrets({ a: [{ b: { password: "x" } }] })).toBe(true);
    expect(hasSecrets({ method: "GET", url: "https://x" })).toBe(false);
  });
});
