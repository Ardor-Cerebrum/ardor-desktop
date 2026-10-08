import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { LocalAgentDesktopHost } from "./desktop-host.js";
import type { LocalAgentTokenRequest } from "./token-broker.js";

const scope = { accountId: "auth0|user-1", workspaceId: "workspace-1" };

function scopeVerificationResponse(
  accountId: string,
  workspaceId: string,
  expiresAt = Math.floor(Date.now() / 1000) + 300,
): Response {
  return new Response(JSON.stringify({ account_id: accountId, workspace_id: workspaceId, expires_at: expiresAt }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function verifiedScopeFetch() {
  return async () => scopeVerificationResponse(scope.accountId, scope.workspaceId);
}

function fulfillScopeTokenRequests(host: LocalAgentDesktopHost): void {
  host.onTokenRequest((request) => {
    if (!request.runtimeId.startsWith("scope-auth:")) return;
    void host.provideToken({
      requestId: request.requestId,
      runtimeId: request.runtimeId,
      generation: request.generation,
      accessToken: "internal-user-token-value",
    });
  });
}

describe("LocalAgentDesktopHost scope authorization", () => {
  test("verifies the signed-in account and workspace before exposing runtime status", async () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-local-agent-scope-test-"));
    const requestedScope = { accountId: "auth0|user-1", workspaceId: "workspace-1" };
    const tokenRequests: LocalAgentTokenRequest[] = [];
    const host = new LocalAgentDesktopHost({
      apiOrigin: "https://console.ardor.cloud",
      arch: "x64",
      channel: "stage1",
      platform: "win32",
      userDataPath: root,
      bundleRoot: join(root, "missing-bundle"),
      expectedSourceCommit: undefined,
      expectedManifestSha256: undefined,
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe("/haron-api/api/cerebrum/desktop/scope");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer internal-user-token-value");
        expect(new Headers(init?.headers).get("x-ardor-workspace-id")).toBe(requestedScope.workspaceId);
        return scopeVerificationResponse(requestedScope.accountId, requestedScope.workspaceId);
      },
    });
    host.onTokenRequest((request) => tokenRequests.push(request));

    try {
      const statusPromise = host.getStatus(requestedScope);
      expect(tokenRequests).toHaveLength(1);
      const tokenRequest = tokenRequests[0];
      expect(tokenRequest).toBeDefined();
      if (!tokenRequest) throw new Error("Expected a one-shot account verification token request.");
      await host.provideToken({
        requestId: tokenRequest.requestId,
        runtimeId: tokenRequest.runtimeId,
        generation: tokenRequest.generation,
        accessToken: "internal-user-token-value",
      });
      await expect(statusPromise).resolves.toMatchObject({ state: "stopped", available: false });
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a renderer account claim that differs from the verified token subject", async () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-local-agent-forged-scope-test-"));
    const requestedScope = { accountId: "auth0|user-2", workspaceId: "workspace-1" };
    const tokenRequests: LocalAgentTokenRequest[] = [];
    const host = new LocalAgentDesktopHost({
      apiOrigin: "https://console.ardor.cloud",
      arch: "x64",
      channel: "stage1",
      platform: "win32",
      userDataPath: root,
      bundleRoot: join(root, "missing-bundle"),
      expectedSourceCommit: undefined,
      expectedManifestSha256: undefined,
      fetch: async () => scopeVerificationResponse("auth0|user-1", "workspace-1"),
    });
    let managerCalls = 0;
    const getStatus = host.manager.getStatus.bind(host.manager);
    host.manager.getStatus = (...args: Parameters<typeof getStatus>) => {
      managerCalls += 1;
      return getStatus(...args);
    };
    host.onTokenRequest((request) => tokenRequests.push(request));

    try {
      const statusPromise = host.getStatus(requestedScope).then(
        () => { throw new Error("Expected unverified renderer scope to be rejected."); },
        (error: unknown) => error,
      );
      const tokenRequest = tokenRequests[0];
      expect(tokenRequest).toBeDefined();
      if (!tokenRequest) throw new Error("Expected a one-shot account verification token request.");
      let tokenReplyError: unknown;
      try {
        await host.provideToken({
          requestId: tokenRequest.requestId,
          runtimeId: tokenRequest.runtimeId,
          generation: tokenRequest.generation,
          accessToken: "internal-user-token-value",
        });
      } catch (error) {
        tokenReplyError = error;
      }
      expect(tokenReplyError).toMatchObject({ message: "Local account or workspace scope could not be verified." });
      expect(await statusPromise).toMatchObject({ message: "Local account or workspace scope could not be verified." });
      expect(managerCalls).toBe(0);
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stops account runtimes during logout even when no scope grant is cached", async () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-local-agent-logout-test-"));
    const host = new LocalAgentDesktopHost({
      apiOrigin: "https://console.ardor.cloud",
      arch: "x64",
      channel: "stage1",
      platform: "win32",
      userDataPath: root,
      bundleRoot: join(root, "missing-bundle"),
      expectedSourceCommit: undefined,
      expectedManifestSha256: undefined,
      fetch: verifiedScopeFetch(),
    });
    let stoppedAccount: string | null = null;
    const stopAccount = host.manager.stopAccount.bind(host.manager);
    host.manager.stopAccount = async (accountId) => {
      stoppedAccount = accountId;
      await stopAccount(accountId);
    };

    try {
      await host.logout(scope.accountId);
      expect(stoppedAccount).toBe(scope.accountId);
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not authorize local history with an expired access token", async () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-local-agent-expired-scope-test-"));
    const tokenRequests: LocalAgentTokenRequest[] = [];
    const host = new LocalAgentDesktopHost({
      apiOrigin: "https://console.ardor.cloud",
      arch: "x64",
      channel: "stage1",
      platform: "win32",
      userDataPath: root,
      bundleRoot: join(root, "missing-bundle"),
      expectedSourceCommit: undefined,
      expectedManifestSha256: undefined,
      fetch: async () => scopeVerificationResponse(scope.accountId, scope.workspaceId, 1),
    });
    let managerCalls = 0;
    const getStatus = host.manager.getStatus.bind(host.manager);
    host.manager.getStatus = (...args: Parameters<typeof getStatus>) => {
      managerCalls += 1;
      return getStatus(...args);
    };
    host.onTokenRequest((request) => tokenRequests.push(request));

    try {
      const statusPromise = host.getStatus(scope).then(
        () => { throw new Error("Expected an expired access token to be rejected."); },
        (error: unknown) => error,
      );
      const tokenRequest = tokenRequests[0];
      expect(tokenRequest).toBeDefined();
      if (!tokenRequest) throw new Error("Expected a one-shot account verification token request.");
      let tokenReplyError: unknown;
      try {
        await host.provideToken({
          requestId: tokenRequest.requestId,
          runtimeId: tokenRequest.runtimeId,
          generation: tokenRequest.generation,
          accessToken: "internal-user-token-value",
        });
      } catch (error) {
        tokenReplyError = error;
      }
      expect(tokenReplyError).toMatchObject({ message: "Local account or workspace scope could not be verified." });
      expect(await statusPromise).toMatchObject({ message: "Local account or workspace scope could not be verified." });
      expect(managerCalls).toBe(0);
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("LocalAgentDesktopHost thread access", () => {
  test("does not enable expanded access from an unconfirmed renderer request", async () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-local-agent-host-test-"));
    const host = new LocalAgentDesktopHost({
      apiOrigin: "https://console.ardor.cloud",
      arch: "x64",
      channel: "stage1",
      platform: "win32",
      userDataPath: root,
      bundleRoot: join(root, "missing-bundle"),
      expectedSourceCommit: undefined,
      expectedManifestSha256: undefined,
      fetch: verifiedScopeFetch(),
    });
    fulfillScopeTokenRequests(host);
    const getThreadProjectFolder = host.manager.getThreadProjectFolder.bind(host.manager);
    host.manager.getThreadProjectFolder = (...args: Parameters<typeof getThreadProjectFolder>) => {
      getThreadProjectFolder(...args);
      return { cwd: root, exists: true };
    };
    const setThreadAccess = host.manager.setThreadAccess.bind(host.manager);
    let managerCalls = 0;
    host.manager.setThreadAccess = (...args: Parameters<typeof setThreadAccess>) => {
      managerCalls += 1;
      return setThreadAccess(...args);
    };

    let result: { readonly expanded: boolean } | null = null;
    try {
      result = await host.setThreadAccess({
        accountId: "auth0|user-1",
        workspaceId: "workspace-1",
        runtimeId: "runtime-1",
        generation: 1,
        threadId: "thread-1",
        expanded: true,
      });
    } catch {
      // The current implementation reaches the manager without asking for confirmation.
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }

    expect(managerCalls).toBe(0);
    expect(result).toEqual({ expanded: false });
  });

  test("enables expanded access only after main-process confirmation for the selected project", async () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-local-agent-host-confirmed-test-"));
    let confirmationCwd = "";
    let confirmationThread = "";
    let managerCalls = 0;
    const host = new LocalAgentDesktopHost({
      apiOrigin: "https://console.ardor.cloud",
      arch: "x64",
      channel: "stage1",
      platform: "win32",
      userDataPath: root,
      bundleRoot: join(root, "missing-bundle"),
      expectedSourceCommit: undefined,
      expectedManifestSha256: undefined,
      fetch: verifiedScopeFetch(),
      confirmExpandedAccess: async ({ cwd, threadId }) => {
        confirmationCwd = cwd;
        confirmationThread = threadId;
        return true;
      },
    });
    fulfillScopeTokenRequests(host);
    host.manager.getThreadProjectFolder = () => ({ cwd: root, exists: true });
    host.manager.setThreadAccess = () => {
      managerCalls += 1;
      return { expanded: true };
    };

    try {
      const result = await host.setThreadAccess({
        accountId: "auth0|user-1",
        workspaceId: "workspace-1",
        runtimeId: "runtime-1",
        generation: 1,
        threadId: "thread-1",
        expanded: true,
      });

      expect(confirmationCwd).toBe(root);
      expect(confirmationThread).toBe("thread-1");
      expect(managerCalls).toBe(1);
      expect(result).toEqual({ expanded: true });
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
