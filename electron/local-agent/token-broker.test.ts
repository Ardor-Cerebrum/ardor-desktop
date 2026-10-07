import { describe, expect, test } from "bun:test";

import { LocalAgentTokenBroker, type LocalAgentTokenRequest } from "./token-broker.js";

describe("LocalAgentTokenBroker", () => {
  test("resolves one short-lived token only for its runtime and generation", async () => {
    const broker = new LocalAgentTokenBroker({ requestTimeoutMs: 500 });
    const requests: LocalAgentTokenRequest[] = [];
    broker.onRequest((request) => requests.push(request));
    const pending = broker.requestToken({
      runtimeId: "runtime-1",
      generation: 3,
      accountId: "auth0|user",
      workspaceId: "workspace-1",
    }, true);
    const request = requests[0];
    expect(request).toMatchObject({
      runtimeId: "runtime-1",
      generation: 3,
      accountId: "auth0|user",
      workspaceId: "workspace-1",
      forceRefresh: true,
    });
    if (!request) throw new Error("token request was not emitted");
    expect(broker.provideToken({ requestId: request.requestId, runtimeId: "runtime-1", generation: 3, accessToken: "eyJ.eyJhbGciOiJIUzI1NiJ9.signature" }))
      .toBe(true);
    await expect(pending).resolves.toBe("eyJ.eyJhbGciOiJIUzI1NiJ9.signature");
    expect(broker.provideToken({ requestId: request.requestId, runtimeId: "runtime-1", generation: 3, accessToken: "second" })).toBe(false);
  });

  test("ignores mismatched runtime, stale generation, and malformed token replies", async () => {
    const broker = new LocalAgentTokenBroker({ requestTimeoutMs: 500 });
    const requests: Array<{ requestId: string; runtimeId: string; generation: number }> = [];
    broker.onRequest((request) => requests.push(request));
    const pending = broker.requestToken({
      runtimeId: "runtime-2",
      generation: 5,
      accountId: "auth0|user",
      workspaceId: "workspace-1",
    }, false);
    const request = requests[0];
    expect(request).toBeDefined();
    if (!request) throw new Error("token request was not emitted");
    expect(broker.provideToken({ requestId: request.requestId, runtimeId: "runtime-other", generation: 5, accessToken: "eyJ.eyJhbGciOiJIUzI1NiJ9.signature" })).toBe(false);
    expect(broker.provideToken({ requestId: request.requestId, runtimeId: "runtime-2", generation: 4, accessToken: "eyJ.eyJhbGciOiJIUzI1NiJ9.signature" })).toBe(false);
    expect(broker.provideToken({ requestId: request.requestId, runtimeId: "runtime-2", generation: 5, accessToken: "bad\r\ntoken" })).toBe(false);
    broker.cancelRuntime("runtime-2", 5);
    await expect(pending).rejects.toThrow("Local auth request was cancelled.");
  });

  test("replays a still-pending token request after renderer reconnect", async () => {
    const broker = new LocalAgentTokenBroker({ requestTimeoutMs: 500 });
    const originalRequests: LocalAgentTokenRequest[] = [];
    broker.onRequest((request) => originalRequests.push(request));
    const pending = broker.requestToken({
      runtimeId: "runtime-3",
      generation: 2,
      accountId: "auth0|user",
      workspaceId: "workspace-1",
    }, false);
    const replayedRequests: LocalAgentTokenRequest[] = [];
    broker.onRequest((request) => replayedRequests.push(request));

    expect(replayedRequests).toEqual(originalRequests);
    const request = replayedRequests[0];
    if (!request) throw new Error("pending token request was not replayed");
    expect(broker.provideToken({
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      generation: request.generation,
      accessToken: "eyJ.eyJhbGciOiJIUzI1NiJ9.signature",
    })).toBe(true);
    await expect(pending).resolves.toBe("eyJ.eyJhbGciOiJIUzI1NiJ9.signature");
  });

  test("cancels only the pending token requests owned by the logged-out account", async () => {
    let sequence = 0;
    const broker = new LocalAgentTokenBroker({
      requestTimeoutMs: 500,
      createRequestId: () => `request-${++sequence}`,
    });
    const userOne = broker.requestToken({
      accountId: "auth0|user-1",
      workspaceId: "workspace-1",
      runtimeId: "runtime-1",
      generation: 1,
    }, false);
    const userTwo = broker.requestToken({
      accountId: "auth0|user-2",
      workspaceId: "workspace-2",
      runtimeId: "runtime-2",
      generation: 1,
    }, false);

    broker.cancelAccount("auth0|user-1");

    await expect(userOne).rejects.toThrow("Local auth request was cancelled.");
    expect(broker.getPendingRequests("auth0|user-1")).toEqual([]);
    expect(broker.getPendingRequests("auth0|user-2")).toHaveLength(1);
    expect(broker.provideToken({
      requestId: "request-2",
      runtimeId: "runtime-2",
      generation: 1,
      accessToken: "x".repeat(32),
    })).toBe(true);
    await expect(userTwo).resolves.toBe("x".repeat(32));
  });
});
