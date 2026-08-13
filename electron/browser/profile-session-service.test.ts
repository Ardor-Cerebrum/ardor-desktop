import { describe, expect, test } from "bun:test";

import { BrowserProfileStore, type BrowserProfileStorage, type CredentialProtector } from "./profile-store";
import { BrowserProfileSessionService, type BrowserProfileSession } from "./profile-session-service";

function createStore() {
  let value: string | undefined;
  const storage: BrowserProfileStorage = {
    load: () => value,
    save: (next) => {
      value = next;
    },
  };
  const protector: CredentialProtector = {
    supported: true,
    encrypt: (input) => input,
    decrypt: (input) => input,
  };
  return new BrowserProfileStore(storage, protector);
}

function createSessions(cookiesByPartition: Record<string, Array<{ domain: string }>>) {
  const cleared: string[] = [];
  const flushed: string[] = [];
  const sessions = new Map<string, BrowserProfileSession>();
  const getSession = (partition: string) => {
    let browserSession = sessions.get(partition);
    if (!browserSession) {
      browserSession = {
        cookies: {
          flushStore: async () => {
            flushed.push(`cookies:${partition}`);
          },
          get: async () => cookiesByPartition[partition] ?? [],
        },
        clearData: async () => {
          cleared.push(`data:${partition}`);
        },
        clearAuthCache: async () => {
          cleared.push(`auth:${partition}`);
        },
        flushStorageData: () => {
          flushed.push(`storage:${partition}`);
        },
      };
      sessions.set(partition, browserSession);
    }
    return browserSession;
  };
  return { cleared, flushed, getSession };
}

describe("BrowserProfileSessionService", () => {
  test("derives no-storage, workspace-shared and session-separated partitions", () => {
    const store = createStore();
    const sessions = createSessions({});
    const service = new BrowserProfileSessionService(sessions.getSession, store);
    const scope = { workspaceId: "workspace-a", sessionId: "session-a" };

    const shared = service.partitionFor(scope);
    store.updateStorageMode("session");
    const separate = service.partitionFor(scope);
    store.updateStorageMode("none");
    const ephemeral = service.partitionFor(scope);

    expect(shared).toMatch(/^persist:ardor-browser-[a-f0-9]{12}$/);
    expect(separate).toMatch(/^persist:ardor-browser-session-[a-f0-9]{12}$/);
    expect(ephemeral).toMatch(/^ardor-browser-[a-f0-9]{12}$/);
    expect(store.trackedPartitions()).toEqual([shared, separate]);
  });

  test("aggregates cookie domains across known Browser partitions", async () => {
    const store = createStore();
    const firstScope = { workspaceId: "workspace-a", sessionId: "session-a" };
    const secondScope = { workspaceId: "workspace-b", sessionId: "session-b" };
    const bootstrap = createSessions({});
    const partitionService = new BrowserProfileSessionService(bootstrap.getSession, store);
    const first = partitionService.partitionFor(firstScope);
    const second = partitionService.partitionFor(secondScope);
    const sessions = createSessions({
      [first]: [{ domain: ".example.com" }, { domain: "example.com" }],
      [second]: [{ domain: "other.test" }],
    });
    const service = new BrowserProfileSessionService(sessions.getSession, store);

    await expect(service.listSiteData()).resolves.toEqual([
      { domain: "example.com", cookieCount: 2 },
      { domain: "other.test", cookieCount: 1 },
    ]);
  });

  test("clears every known partition when persistence is disabled", async () => {
    const store = createStore();
    const sessions = createSessions({});
    const service = new BrowserProfileSessionService(sessions.getSession, store);
    service.partitionFor({ workspaceId: "workspace-a", sessionId: "session-a" });

    const snapshot = await service.setStorageMode("none");

    expect(snapshot.storageMode).toBe("none");
    expect(sessions.cleared).toContain("data:persist:ardor-browser");
    expect(sessions.cleared).toContain("auth:persist:ardor-browser");
    expect(sessions.cleared.some((event) => event.startsWith("data:persist:ardor-browser-"))).toBe(true);
  });

  test("flushes cookies and DOM storage for every persistent Browser partition", async () => {
    const store = createStore();
    const sessions = createSessions({});
    const service = new BrowserProfileSessionService(sessions.getSession, store);
    const persistent = service.partitionFor({ workspaceId: "workspace-a", sessionId: "session-a" });
    store.updateStorageMode("none");
    const ephemeral = service.partitionFor({ workspaceId: "workspace-b", sessionId: "session-b" });

    await expect(service.flushPersistentData()).resolves.toBeUndefined();

    expect(sessions.flushed).toContain("storage:persist:ardor-browser");
    expect(sessions.flushed).toContain("cookies:persist:ardor-browser");
    expect(sessions.flushed).toContain(`storage:${persistent}`);
    expect(sessions.flushed).toContain(`cookies:${persistent}`);
    expect(sessions.flushed.some((event) => event.endsWith(ephemeral))).toBe(false);
  });

  test("reports a persistent Browser partition that cannot be flushed", async () => {
    const store = createStore();
    const sessions = createSessions({});
    const service = new BrowserProfileSessionService((partition) => {
      const browserSession = sessions.getSession(partition);
      if (partition === "persist:ardor-browser") {
        return {
          ...browserSession,
          cookies: {
            ...browserSession.cookies,
            flushStore: async () => {
              throw new Error("flush failed");
            },
          },
        };
      }
      return browserSession;
    }, store);

    await expect(service.flushPersistentData()).rejects.toThrow("flush failed");
  });
});
