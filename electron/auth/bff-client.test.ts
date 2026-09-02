import { describe, expect, test } from "bun:test";

import { IdentityBffClient } from "./bff-client";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "content-length": String(JSON.stringify(body).length) },
  });

function authorizationUrl(overrides: Record<string, string | string[]> = {}): string {
  const url = new URL("https://auth.example/authorize");
  const parameters: Record<string, string | string[]> = {
    client_id: "desktop-client",
    redirect_uri: "http://127.0.0.1:17631/auth/callback",
    response_type: "code",
    state: "expected-state",
    nonce: "expected-nonce",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [name, rawValues] of Object.entries(parameters)) {
    for (const value of Array.isArray(rawValues) ? rawValues : [rawValues]) url.searchParams.append(name, value);
  }
  return url.toString();
}

const bffOptions = {
  authorizationDomain: "auth.example",
  authorizationClientId: "desktop-client",
};

describe("IdentityBffClient", () => {
  test("starts desktop auth and requires a bounded HTTPS authorization URL with one state", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new IdentityBffClient("https://identity.example", async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        authorization_url: authorizationUrl(),
        transaction_id: "transaction-1234567890",
      });
    }, bffOptions);

    await expect(client.start("http://127.0.0.1:17631/auth/callback")).resolves.toEqual({
      authorizationUrl: authorizationUrl(),
      transactionId: "transaction-1234567890",
    });
    expect(requests[0]?.url).toBe("https://identity.example/identity-workspace-api/api/v1/auth/session/start");
    expect(requests[0]?.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      client_kind: "desktop",
      redirect_uri: "http://127.0.0.1:17631/auth/callback",
    });
  });

  test("redeems grants and rotates handles without exposing them in token results", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const responses = [
      { session_handle: "opaque-new-handle-1234567890" },
      {
        access_token: "signed-internal-jwt",
        token_type: "Bearer",
        expires_in: 900,
        replacement_session_handle: "opaque-replacement-handle-1234567890",
        user: {
          user_id: "user-1",
          email: "user@example.test",
          role: "USER",
          workspace_id: "workspace-1",
          is_beta_user: false,
          is_developer: true,
        },
      },
    ];
    const client = new IdentityBffClient("http://127.0.0.1:9000", async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      return jsonResponse(responses.shift());
    });

    await expect(client.redeem("one-time-grant-1234567890", "opaque-old-handle-1234567890"))
      .resolves.toEqual({ sessionHandle: "opaque-new-handle-1234567890" });
    const minted = await client.mint("opaque-new-handle-1234567890");
    expect(minted).toEqual({
      internalToken: "signed-internal-jwt",
      expiresIn: 900,
      replacementSessionHandle: "opaque-replacement-handle-1234567890",
      user: {
        userId: "user-1",
        email: "user@example.test",
        role: "USER",
        workspaceId: "workspace-1",
        isBetaUser: false,
        isDeveloper: true,
      },
    });
    expect(JSON.stringify(minted)).not.toContain("opaque-new-handle");
    expect(requests[0]?.headers.get("x-ardor-desktop-grant")).toBe("one-time-grant-1234567890");
    expect(requests[0]?.headers.get("x-ardor-session-handle")).toBe("opaque-old-handle-1234567890");
    expect(requests[1]?.headers.get("x-ardor-session-handle")).toBe("opaque-new-handle-1234567890");
  });

  test("uses generic failures and rejects redirects, oversized payloads, and invalid response shapes", async () => {
    const redirecting = new IdentityBffClient("https://identity.example", async () =>
      new Response(null, { status: 302, headers: { location: "https://attacker.example" } }),
    );
    await expect(redirecting.mint("opaque-session-handle-1234567890")).rejects.toThrow(
      "desktop authentication request failed",
    );

    const oversized = new IdentityBffClient("https://identity.example", async () =>
      new Response("x", { headers: { "content-type": "application/json", "content-length": "70000" } }),
    );
    await expect(oversized.mint("opaque-session-handle-1234567890")).rejects.toThrow(
      "desktop authentication request failed",
    );

    const malformed = new IdentityBffClient("https://identity.example", async () =>
      jsonResponse({ access_token: "secret", expires_in: 900 }),
    );
    await expect(malformed.mint("opaque-session-handle-1234567890")).rejects.toThrow(
      "desktop authentication request failed",
    );
  });

  test("pins the external authorization destination to the configured Auth0 domain", async () => {
    for (const authorizationUrl of [
      "https://attacker.example/authorize?state=expected",
      "https://auth.example:444/authorize?state=expected",
      "https://auth.example/untrusted?state=expected",
    ]) {
      const client = new IdentityBffClient(
        "https://identity.example",
        async () => jsonResponse({
          authorization_url: authorizationUrl,
          transaction_id: "transaction-1234567890",
        }),
        bffOptions,
      );

      await expect(client.start("http://127.0.0.1:17631/auth/callback")).rejects.toThrow(
        "desktop authentication request failed",
      );
    }
  });

  test("rejects wrong or duplicate authorization client, redirect, state, and fragments", async () => {
    const invalidUrls = [
      authorizationUrl({ client_id: "other-client" }),
      authorizationUrl({ client_id: ["desktop-client", "desktop-client"] }),
      authorizationUrl({ redirect_uri: "http://127.0.0.1:17631/other" }),
      authorizationUrl({ redirect_uri: ["http://127.0.0.1:17631/auth/callback", "http://127.0.0.1:17631/auth/callback"] }),
      authorizationUrl({ state: ["expected-state", "other-state"] }),
      `${authorizationUrl()}#forbidden`,
    ];
    for (const invalidUrl of invalidUrls) {
      const client = new IdentityBffClient(
        "https://identity.example",
        async () => jsonResponse({ authorization_url: invalidUrl, transaction_id: "transaction-1234567890" }),
        bffOptions,
      );
      await expect(client.start("http://127.0.0.1:17631/auth/callback")).rejects.toThrow(
        "desktop authentication request failed",
      );
    }
  });

  test("bounds a fetch that never resolves and aborts it", async () => {
    let signal: AbortSignal | null = null;
    const client = new IdentityBffClient(
      "https://identity.example",
      async (_url, init) => {
        signal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      },
      { ...bffOptions, requestTimeoutMs: 10 },
    );

    await expect(client.mint("opaque-session-handle-1234567890")).rejects.toThrow(
      "desktop authentication request failed",
    );
    expect(signal?.aborted).toBe(true);
  });

  test("cancels a response stream that stalls after partial bytes", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new IdentityBffClient(
      "https://identity.example",
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
      { ...bffOptions, requestTimeoutMs: 10 },
    );

    await expect(client.mint("opaque-session-handle-1234567890")).rejects.toThrow(
      "desktop authentication request failed",
    );
    expect(cancelled).toBe(true);
  });

  test("rejects a user context outside the closed identity role contract", async () => {
    const client = new IdentityBffClient("https://identity.example", async () => jsonResponse({
      access_token: "signed-internal-jwt",
      token_type: "Bearer",
      expires_in: 900,
      replacement_session_handle: "opaque-replacement-handle-1234567890",
      user: {
        user_id: "user-1",
        email: "user@example.test",
        role: "OWNER",
        workspace_id: "workspace-1",
        is_beta_user: false,
        is_developer: false,
      },
    }));

    await expect(client.mint("opaque-session-handle-1234567890")).rejects.toThrow(
      "desktop authentication request failed",
    );
  });

  test("requires the identity developer flag to be a boolean", async () => {
    for (const isDeveloper of [undefined, null, "true", 1]) {
      const client = new IdentityBffClient("https://identity.example", async () => jsonResponse({
        access_token: "signed-internal-jwt",
        token_type: "Bearer",
        expires_in: 900,
        replacement_session_handle: "opaque-replacement-handle-1234567890",
        user: {
          user_id: "user-1",
          email: "user@example.test",
          role: "USER",
          workspace_id: "workspace-1",
          is_beta_user: false,
          is_developer: isDeveloper,
        },
      }));

      await expect(client.mint("opaque-session-handle-1234567890")).rejects.toThrow(
        "desktop authentication request failed",
      );
    }
  });
});
