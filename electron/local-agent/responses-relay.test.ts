import { describe, expect, test } from "bun:test";

import { LocalResponsesRelay } from "./responses-relay.js";

describe("LocalResponsesRelay", () => {
  test("forwards native SSE to the fixed Haron route with runtime workspace and thread identity", async () => {
    let forwardedUrl = "";
    let forwardedHeaders = new Headers();
    const relay = createRelay(async (input, init) => {
      forwardedUrl = String(input);
      forwardedHeaders = new Headers(init?.headers);
      return new Response("data: {\"type\":\"response.completed\"}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    try {
      const port = await relay.start();
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer runtime-secret-runtime-secret-value-123456",
          "content-type": "application/json",
          "thread-id": "thread-1",
        },
        body: JSON.stringify({ model: "gpt-6-luna", input: [] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(await response.text()).toContain("response.completed");
      expect(forwardedUrl).toBe("https://console.ardor.cloud/haron-api/api/cerebrum/desktop/responses");
      expect(forwardedHeaders.get("authorization")).toBe("Bearer user-internal-access-token");
      expect(forwardedHeaders.get("x-ardor-workspace-id")).toBe("workspace-1");
      expect(forwardedHeaders.get("thread-id")).toBe("thread-1");
      expect(forwardedHeaders.get("authorization")).not.toContain("runtime-secret-runtime");
    } finally {
      await relay.stop();
    }
  });

  test("rejects non-loopback credentials and non-Responses routes before token lookup", async () => {
    let tokenRequests = 0;
    const relay = createRelay(async () => new Response("unused"), async () => {
      tokenRequests += 1;
      return "user-internal-access-token";
    });
    try {
      const port = await relay.start();
      const invalidToken = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer wrong", "thread-id": "thread-1" },
        body: "{}",
      });
      const unsupportedPath = await fetch(`http://127.0.0.1:${port}/v1/other`, {
        method: "POST",
        headers: { authorization: "Bearer runtime-secret-runtime-secret-value-123456", "thread-id": "thread-1" },
        body: "{}",
      });
      expect(invalidToken.status).toBe(401);
      expect(unsupportedPath.status).toBe(404);
      expect(tokenRequests).toBe(0);
    } finally {
      await relay.stop();
    }
  });

  test("refreshes the account token once after upstream auth expiry", async () => {
    const refreshModes: boolean[] = [];
    let attempts = 0;
    const relay = createRelay(async (_input, init) => {
      attempts += 1;
      if (attempts === 1) return new Response("expired", { status: 401 });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer refreshed-token-value");
      return new Response("data: done\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }, async (forceRefresh) => {
      refreshModes.push(forceRefresh);
      return forceRefresh ? "refreshed-token-value" : "user-internal-access-token";
    });
    try {
      const port = await relay.start();
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer runtime-secret-runtime-secret-value-123456", "thread-id": "thread-1", "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("done");
      expect(attempts).toBe(2);
      expect(refreshModes).toEqual([false, true]);
    } finally {
      await relay.stop();
    }
  });
});

function createRelay(
  fetcher: typeof fetch,
  getAccessToken: (forceRefresh: boolean) => Promise<string> = async () => "user-internal-access-token",
) {
  return new LocalResponsesRelay({
    apiOrigin: "https://console.ardor.cloud",
    runtimeId: "runtime-1",
    generation: 1,
    relayToken: "runtime-secret-runtime-secret-value-123456",
    scope: { accountId: "auth0|user", workspaceId: "workspace-1" },
    getAccessToken,
    fetch: fetcher,
  });
}
