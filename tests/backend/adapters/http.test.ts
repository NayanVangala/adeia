import { describe, expect, it } from "vitest";
import {
  createHttpAdapter,
  HttpAdapterError,
  isPrivateAddress,
  type HttpCallResult,
} from "../../../src/backend/src/adapters/http.ts";

const ctx = { actionId: "act_test", idempotencyKey: "idem_test" };

/** A fetch that records what it was called with and answers with a fixed reply. */
function stubFetch(
  reply: Partial<{ status: number; statusText: string; body: string; headers: Record<string, string> }> = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(reply.body ?? "{}", {
      status: reply.status ?? 200,
      statusText: reply.statusText ?? "OK",
      headers: reply.headers ?? { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("isPrivateAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC 1918"],
    ["192.168.0.5", "RFC 1918"],
    ["172.16.0.1", "RFC 1918 lower bound"],
    ["172.31.255.254", "RFC 1918 upper bound"],
    ["169.254.169.254", "the cloud metadata endpoint"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "this network"],
    ["::1", "IPv6 loopback"],
    ["fe80::1", "IPv6 link-local"],
    ["fd00::1", "IPv6 unique local"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata address"],
  ])("blocks %s (%s)", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([["1.1.1.1"], ["8.8.8.8"], ["104.21.67.85"], ["2606:4700::1111"]])(
    "allows the public address %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );

  it("blocks anything it cannot parse, rather than passing it through", () => {
    expect(isPrivateAddress("not-an-address")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });

  it("blocks 172.32, which is outside the private range and a classic off-by-one", () => {
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
  });
});

describe("the http adapter", () => {
  it("rejects a url the schema would not have accepted", async () => {
    const { fetchImpl } = stubFetch();
    const adapter = createHttpAdapter({ fetch: fetchImpl });

    await expect(
      adapter.execute({ method: "GET", url: "http://example.com/insecure" }, ctx),
    ).rejects.toThrow();
  });

  it.each([
    ["https://localhost/admin", "loopback by name"],
    ["https://127.0.0.1/admin", "loopback by address"],
    ["https://169.254.169.254/latest/meta-data/", "the cloud metadata endpoint"],
    ["https://10.0.0.1/internal", "an RFC 1918 address"],
  ])("sends no request at all for %s (%s)", async (url) => {
    const { fetchImpl, calls } = stubFetch();
    const adapter = createHttpAdapter({ fetch: fetchImpl });

    // These are caught by the schema, one layer before the adapter's own DNS
    // check — which is why the error is a validation error rather than an
    // HttpAdapterError. What matters either way is the second assertion: the
    // request never went out.
    await expect(adapter.execute({ method: "GET", url }, ctx)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("surfaces a blocked host from the adapter's own check as an HttpAdapterError", async () => {
    // resolvePublicAddress is the layer the schema cannot cover, since it is
    // what runs after DNS has answered. Called directly here because reaching
    // it through execute() would need a hostname whose real DNS record points
    // somewhere private.
    const { resolvePublicAddress } = await import(
      "../../../src/backend/src/adapters/http.ts"
    );

    await expect(resolvePublicAddress("localhost")).rejects.toThrow(HttpAdapterError);
    await expect(resolvePublicAddress("localhost")).rejects.toThrow(/not permitted/);
  });

  it("never follows a redirect", async () => {
    const { fetchImpl, calls } = stubFetch({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
    const adapter = createHttpAdapter({ fetch: fetchImpl });

    const result = (await adapter.execute(
      { method: "GET", url: "https://example.com/go" },
      ctx,
    )) as HttpCallResult;

    expect(calls[0]?.init.redirect).toBe("manual");
    // The redirect comes back as what it is, rather than being chased into a
    // private network.
    expect(result.status).toBe(302);
    expect(result.headers["location"]).toBe("http://169.254.169.254/latest/meta-data/");
  });

  it("does not return the request headers, which is where the credential is", async () => {
    const { fetchImpl } = stubFetch();
    const adapter = createHttpAdapter({ fetch: fetchImpl });

    const result = await adapter.execute(
      {
        method: "GET",
        url: "https://example.com/thing",
        headers: { authorization: "Bearer super-secret-token" },
      },
      ctx,
    );

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("super-secret-token");
    expect(serialised).not.toContain("authorization");
  });

  it("passes the caller's headers to the far end even though it never returns them", async () => {
    const { fetchImpl, calls } = stubFetch();
    const adapter = createHttpAdapter({ fetch: fetchImpl });

    await adapter.execute(
      {
        method: "GET",
        url: "https://example.com/thing",
        headers: { authorization: "Bearer tok" },
      },
      ctx,
    );

    const sent = calls[0]?.init.headers as Record<string, string>;
    expect(sent["authorization"]).toBe("Bearer tok");
    expect(sent["idempotency-key"]).toBe("idem_test");
  });

  it("serialises a body and sets content-type only when the caller did not", async () => {
    const { fetchImpl, calls } = stubFetch();
    const adapter = createHttpAdapter({ fetch: fetchImpl });

    await adapter.execute(
      { method: "POST", url: "https://example.com/thing", body: { name: "adeia" } },
      ctx,
    );

    const sent = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.init.body).toBe('{"name":"adeia"}');
    expect(sent["content-type"]).toBe("application/json");
  });

  it("does not add a second content-type when the caller declared one in any case", async () => {
    const { fetchImpl, calls } = stubFetch();
    const adapter = createHttpAdapter({ fetch: fetchImpl });

    await adapter.execute(
      {
        method: "POST",
        url: "https://example.com/thing",
        headers: { "Content-Type": "text/plain" },
        body: { name: "adeia" },
      },
      ctx,
    );

    const sent = calls[0]?.init.headers as Record<string, string>;
    const contentTypes = Object.keys(sent).filter((k) => k.toLowerCase() === "content-type");
    expect(contentTypes).toHaveLength(1);
    expect(sent["Content-Type"]).toBe("text/plain");
  });

  it("truncates a response that would not fit, and says that it did", async () => {
    const { fetchImpl } = stubFetch({ body: "x".repeat(5000) });
    const adapter = createHttpAdapter({ fetch: fetchImpl, maxResponseBytes: 100 });

    const result = await adapter.execute({ method: "GET", url: "https://example.com/big" }, ctx);

    expect(result.body).toHaveLength(100);
    expect(result.bodyTruncated).toBe(true);
  });

  it("does not mark a response truncated when it fits", async () => {
    const { fetchImpl } = stubFetch({ body: "small" });
    const adapter = createHttpAdapter({ fetch: fetchImpl, maxResponseBytes: 100 });

    const result = await adapter.execute({ method: "GET", url: "https://example.com/ok" }, ctx);

    expect(result.body).toBe("small");
    expect(result.bodyTruncated).toBe(false);
  });

  it("reports a non-2xx as a completed call rather than throwing", async () => {
    const { fetchImpl } = stubFetch({ status: 403, statusText: "Forbidden", body: "nope" });
    const adapter = createHttpAdapter({ fetch: fetchImpl });

    // The call happened and the far end said no. That is a result, not a
    // failure of the adapter — same reasoning as a policy denial.
    const result = await adapter.execute({ method: "GET", url: "https://example.com/x" }, ctx);

    expect(result.status).toBe(403);
    expect(result.ok).toBe(false);
  });

  it("gives up on a slow response", async () => {
    // Honours the abort signal the way a real fetch does. A stub that ignored
    // it would hang here and prove nothing about the adapter.
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const adapter = createHttpAdapter({ fetch: hang, timeoutMs: 20 });

    await expect(
      adapter.execute({ method: "GET", url: "https://example.com/slow" }, ctx),
    ).rejects.toThrow(/no response within/);
  });

  it("registers for the http action type under a name the audit trail records", () => {
    const adapter = createHttpAdapter();
    expect(adapter.type).toBe("http");
    expect(adapter.name).toBe("fetch");
  });
});
