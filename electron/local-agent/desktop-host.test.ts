import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { LocalAgentDesktopHost } from "./desktop-host.js";

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
    });
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
      confirmExpandedAccess: async ({ cwd, threadId }) => {
        confirmationCwd = cwd;
        confirmationThread = threadId;
        return true;
      },
    });
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
