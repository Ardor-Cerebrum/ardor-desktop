import { describe, expect, test } from "bun:test";

import { DesktopAuthSessionService } from "./desktop-session";
import { IdentityBffClient } from "./bff-client";

describe("DesktopAuthSessionService", () => {
  test("starts through the BFF before opening the browser and redeems only a validated pending grant", async () => {
    const calls: string[] = [];
    let stored: string | null = "old-desktop-handle-1234567890";
    const service = new DesktopAuthSessionService({
      callback: {
        start: async () => calls.push("listen"),
        beginAuthorization: (url) => {
          calls.push(`begin:${url}`);
          return 7;
        },
        cancelAuthorization: () => true,
        takePending: () => ({ id: 9, grant: "one-time-grant-1234567890" }),
        complete: () => true,
      },
      client: {
        start: async () => {
          calls.push("bff-start");
          return { authorizationUrl: "https://auth.example/authorize?state=expected", transactionId: "tx-1" };
        },
        redeem: async (grant, previous) => {
          calls.push(`redeem:${grant}:${previous}`);
          return { sessionHandle: "new-desktop-handle-1234567890" };
        },
        mint: async () => { throw new Error("unused"); },
        logout: async () => 1,
        logoutAll: async () => 1,
      },
      openExternal: async () => calls.push("open"),
      vault: {
        load: () => stored,
        save: (value) => { calls.push(`save:${value}`); stored = value; },
        clear: () => { stored = null; },
      },
      now: () => 1_000,
    });

    const appState = Object.freeze({
      returnTo: "/invitations/invite-1?source=desktop",
      userCopilotInput: "build a map",
    });
    await expect(service.start(appState)).resolves.toEqual({ state: "authorizing", recoverable: true });
    expect(calls).toEqual([
      "listen",
      "bff-start",
      "begin:https://auth.example/authorize?state=expected",
      "open",
    ]);
    await expect(service.completeCallback()).resolves.toEqual({
      state: "authenticated",
      recoverable: true,
      appState,
    });
    expect(service.getStatus()).toEqual({ state: "authenticated", recoverable: true, appState });
    expect(calls.slice(4)).toEqual([
      "redeem:one-time-grant-1234567890:old-desktop-handle-1234567890",
      "save:new-desktop-handle-1234567890",
    ]);
  });

  test("keeps an immutable renderer-safe copy of app state across the native callback", async () => {
    const source = {
      returnTo: "/agent/new?source=desktop",
      userCopilotInput: "continue this task",
    };
    const emitted: unknown[] = [];
    const service = new DesktopAuthSessionService({
      callback: {
        start: async () => undefined,
        beginAuthorization: () => 1,
        cancelAuthorization: () => true,
        takePending: () => ({ id: 1, grant: "one-time-grant-1234567890" }),
        complete: () => true,
      },
      client: {
        start: async () => ({
          authorizationUrl: "https://auth.example/authorize?state=expected",
          transactionId: "tx-1",
        }),
        redeem: async () => ({ sessionHandle: "new-desktop-handle-1234567890" }),
        mint: async () => { throw new Error("unused"); },
        logout: async () => 1,
        logoutAll: async () => 1,
      },
      openExternal: async () => undefined,
      vault: {
        load: () => null,
        save: () => undefined,
        clear: () => undefined,
      },
      onStatusChanged: (status) => emitted.push(status),
    });

    await service.start(source);
    source.returnTo = "/attacker-controlled";
    source.userCopilotInput = "changed";
    const completed = await service.completeCallback();

    expect(completed).toEqual({
      state: "authenticated",
      recoverable: true,
      appState: {
        returnTo: "/agent/new?source=desktop",
        userCopilotInput: "continue this task",
      },
    });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.appState)).toBe(true);
    expect(emitted.at(-1)).toBe(completed);
    expect(JSON.stringify(completed)).not.toContain("grant");
    expect(JSON.stringify(completed)).not.toContain("handle");
  });

  test("clears pending app state when callback redemption fails or the session logs out", async () => {
    let redemptionFails = true;
    const service = new DesktopAuthSessionService({
      callback: {
        start: async () => undefined,
        beginAuthorization: () => 1,
        cancelAuthorization: () => true,
        takePending: () => ({ id: 1, grant: "one-time-grant-1234567890" }),
        complete: () => true,
      },
      client: {
        start: async () => ({
          authorizationUrl: "https://auth.example/authorize?state=expected",
          transactionId: "tx-1",
        }),
        redeem: async () => {
          if (redemptionFails) throw new Error("offline");
          return { sessionHandle: "new-desktop-handle-1234567890" };
        },
        mint: async () => { throw new Error("unused"); },
        logout: async () => 1,
        logoutAll: async () => 1,
      },
      openExternal: async () => undefined,
      vault: {
        load: () => null,
        save: () => undefined,
        clear: () => undefined,
      },
    });

    await service.start({ returnTo: "/first" });
    await expect(service.completeCallback()).rejects.toThrow("desktop authentication is unavailable");
    expect(service.getStatus()).not.toHaveProperty("appState");

    redemptionFails = false;
    await service.start({ returnTo: "/second" });
    await expect(service.completeCallback()).resolves.toHaveProperty("appState.returnTo", "/second");
    await expect(service.logout()).resolves.toEqual({ state: "signed-out", recoverable: true });
    expect(service.getStatus()).not.toHaveProperty("appState");
  });

  test("persists every replacement before returning a renderer-safe token", async () => {
    const calls: string[] = [];
    let stored: string | null = "old-desktop-handle-1234567890";
    const service = new DesktopAuthSessionService({
      callback: null,
      client: {
        start: async () => { throw new Error("unused"); },
        redeem: async () => { throw new Error("unused"); },
        mint: async () => {
          calls.push("mint");
          return {
            internalToken: "signed-internal-jwt",
            expiresIn: 900,
            replacementSessionHandle: "new-desktop-handle-1234567890",
            user: { userId: "u1", email: "u@example.test", role: "USER", workspaceId: "w1", isBetaUser: true, isDeveloper: false },
          };
        },
        logout: async (handle) => { calls.push(`revoke:${handle}`); return 1; },
        logoutAll: async () => 1,
      },
      openExternal: async () => undefined,
      vault: {
        load: () => stored,
        save: (value) => { calls.push(`save:${value}`); stored = value; },
        clear: () => { calls.push("clear"); stored = null; },
      },
      now: () => 1_000,
    });

    const result = await service.getToken();
    expect(calls).toEqual(["mint", "save:new-desktop-handle-1234567890"]);
    expect(result).toEqual({
      internalToken: "signed-internal-jwt",
      expiresAt: 901_000,
      user: { userId: "u1", email: "u@example.test", role: "USER", workspaceId: "w1", isBetaUser: true, isDeveloper: false },
    });
    expect(JSON.stringify(result)).not.toContain("handle");
  });

  test.each([
    ["logout", "revoke"],
    ["logoutAll", "revoke-all"],
  ] as const)("clears the encrypted handle after offline %s even when remote revocation fails", async (method, revokeCall) => {
    const calls: string[] = [];
    let stored: string | null = "old-desktop-handle-1234567890";
    const service = new DesktopAuthSessionService({
      callback: null,
      client: {
        start: async () => { throw new Error("unused"); },
        redeem: async () => { throw new Error("unused"); },
        mint: async () => { calls.push("mint"); throw new Error("unused"); },
        logout: async () => {
          calls.push("revoke");
          throw new Error("offline");
        },
        logoutAll: async () => { calls.push("revoke-all"); throw new Error("offline"); },
      },
      openExternal: async () => undefined,
      vault: {
        load: () => stored,
        save: () => undefined,
        clear: () => { calls.push("clear"); stored = null; },
      },
      now: () => 1_000,
    });

    expect(service.initialize()).toEqual({ state: "authenticated", recoverable: true });
    await expect(service[method]()).rejects.toThrow("desktop authentication is unavailable");
    expect(calls).toEqual([revokeCall, "clear"]);
    expect(stored).toBeNull();
    expect(service.getStatus()).toEqual({ state: "signed-out", recoverable: true });
    await expect(service.getToken()).rejects.toThrow("desktop authentication is required");
    expect(calls).not.toContain("mint");

    await expect(service[method]()).resolves.toEqual({ state: "signed-out", recoverable: true });
    expect(calls).toEqual([revokeCall, "clear", "clear"]);
    expect(stored).toBeNull();
  });

  test("does not start a remote flow when encrypted storage is unavailable", async () => {
    const calls: string[] = [];
    const service = new DesktopAuthSessionService({
      callback: {
        start: async () => calls.push("listen"),
        beginAuthorization: () => 1,
        cancelAuthorization: () => true,
        takePending: () => null,
        complete: () => false,
      },
      client: {
        start: async () => { calls.push("bff-start"); throw new Error("unused"); },
        redeem: async () => { throw new Error("unused"); },
        mint: async () => { throw new Error("unused"); },
        logout: async () => 0,
        logoutAll: async () => 0,
      },
      openExternal: async () => calls.push("open"),
      vault: {
        load: () => { throw new Error("safeStorage unavailable"); },
        save: () => undefined,
        clear: () => undefined,
      },
    });

    await expect(service.start()).rejects.toThrow("desktop authentication is unavailable");
    expect(calls).toEqual([]);
    expect(service.getStatus()).toEqual({
      state: "error",
      recoverable: true,
      reason: "encryption-unavailable",
    });
  });

  test("revokes the rotated handle and returns no token when atomic vault replacement fails", async () => {
    const calls: string[] = [];
    const service = new DesktopAuthSessionService({
      callback: null,
      client: {
        start: async () => { throw new Error("unused"); },
        redeem: async () => { throw new Error("unused"); },
        mint: async () => ({
          internalToken: "signed-internal-jwt",
          expiresIn: 900,
          replacementSessionHandle: "rotated-desktop-handle-1234567890",
          user: { userId: "u1", email: "u@example.test", role: "USER", workspaceId: "w1", isBetaUser: false, isDeveloper: true },
        }),
        logout: async (handle) => { calls.push(`revoke:${handle}`); return 1; },
        logoutAll: async () => 1,
      },
      openExternal: async () => undefined,
      vault: {
        load: () => "old-desktop-handle-1234567890",
        save: () => { calls.push("save"); throw new Error("disk failure"); },
        clear: () => calls.push("clear"),
      },
    });

    await expect(service.getToken()).rejects.toThrow("desktop authentication is unavailable");
    expect(calls).toEqual(["save", "revoke:rotated-desktop-handle-1234567890", "clear"]);
  });

  test("maps callback redemption failures to a generic recoverable status", async () => {
    const calls: string[] = [];
    const service = new DesktopAuthSessionService({
      callback: {
        start: async () => undefined,
        beginAuthorization: () => 1,
        cancelAuthorization: () => true,
        takePending: () => ({ id: 1, grant: "one-time-grant-1234567890" }),
        complete: () => true,
      },
      client: {
        start: async () => { throw new Error("unused"); },
        redeem: async () => { throw new Error("provider included sensitive details"); },
        mint: async () => { throw new Error("unused"); },
        logout: async () => 0,
        logoutAll: async () => 0,
      },
      openExternal: async () => undefined,
      vault: {
        load: () => null,
        save: () => undefined,
        clear: () => calls.push("clear"),
      },
    });

    await expect(service.completeCallback()).rejects.toThrow("desktop authentication is unavailable");
    expect(service.getStatus()).toEqual({ state: "error", recoverable: true, reason: "network" });
    expect(calls).toEqual(["clear"]);
  });

  test("maps token mint failures without surfacing upstream details", async () => {
    const calls: string[] = [];
    const service = new DesktopAuthSessionService({
      callback: null,
      client: {
        start: async () => { throw new Error("unused"); },
        redeem: async () => { throw new Error("unused"); },
        mint: async () => { throw new Error("upstream included a credential"); },
        logout: async () => 0,
        logoutAll: async () => 0,
      },
      openExternal: async () => undefined,
      vault: {
        load: () => "old-desktop-handle-1234567890",
        save: () => undefined,
        clear: () => calls.push("clear"),
      },
    });

    await expect(service.getToken()).rejects.toThrow("desktop authentication is unavailable");
    expect(service.getStatus()).toEqual({ state: "error", recoverable: true, reason: "network" });
    expect(calls).toEqual(["clear"]);
  });

  test("releases the serialized auth queue after a BFF deadline", async () => {
    let request = 0;
    let stored: string | null = "old-desktop-handle-1234567890";
    const client = new IdentityBffClient(
      "https://identity.example",
      async () => {
        request += 1;
        if (request === 1) return new Promise<Response>(() => undefined);
        return jsonTokenResponse();
      },
      { requestTimeoutMs: 10 },
    );
    const service = new DesktopAuthSessionService({
      callback: null,
      client,
      openExternal: async () => undefined,
      vault: {
        load: () => stored,
        save: (value) => { stored = value; },
        clear: () => { stored = null; },
      },
    });

    await expect(service.getToken()).rejects.toThrow("desktop authentication is unavailable");
    stored = "reauthenticated-handle-1234567890";
    await expect(service.getToken()).resolves.toMatchObject({ internalToken: "signed-internal-jwt" });
    expect(request).toBe(2);
  });
});

function jsonTokenResponse(): Response {
  const body = JSON.stringify({
    access_token: "signed-internal-jwt",
    token_type: "Bearer",
    expires_in: 900,
    replacement_session_handle: "replacement-handle-1234567890",
    user: {
      user_id: "user-1",
      email: "user@example.test",
      role: "USER",
      workspace_id: "workspace-1",
      is_beta_user: false,
      is_developer: false,
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/json", "content-length": String(body.length) },
  });
}
