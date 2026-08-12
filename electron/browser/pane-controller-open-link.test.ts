import { describe, expect, test } from "bun:test";

import type { BrowserHostCallbacks, BrowserPaneHost, BrowserTabHandle } from "./controller";
import { BrowserPaneController } from "./pane-controller";
import { BrowserPaneSessionStore } from "./pane-session-store";

interface FakeHandle extends BrowserTabHandle {
  closed: boolean;
  loads: string[];
}

function createFakeHost(options: { asyncFailures?: ReadonlySet<string>; syncFailures?: ReadonlySet<string> } = {}) {
  const handles = new Map<string, FakeHandle>();
  const presentationEvents: string[] = [];
  const create: BrowserPaneHost["create"] = (
    tabId,
    _partition,
    _onUrlChanged,
    callbacks: BrowserHostCallbacks = {},
  ) => {
      let currentUrl = "about:blank";
      const handle: FakeHandle = {
        closed: false,
        loads: [],
        load: (url) => {
          handle.loads.push(url);
          presentationEvents.push(`load:${tabId}:${url}`);
          if (options.syncFailures?.has(url)) throw new Error("synchronous load failure");
          if (options.asyncFailures?.has(url)) return Promise.reject(new Error("asynchronous load failure"));
          currentUrl = url;
          callbacks.onStateChanged?.();
          return Promise.resolve();
        },
        url: () => currentUrl,
        title: () => "",
        setBounds: () => undefined,
        setVisible: (visible) => {
          presentationEvents.push(`visible:${tabId}:${visible}`);
        },
        raise: () => {
          presentationEvents.push(`raise:${tabId}`);
        },
        invalidate: () => {
          presentationEvents.push(`invalidate:${tabId}`);
        },
        close: () => {
          handle.closed = true;
        },
        sendCommand: async () => ({}),
      };
      handles.set(tabId, handle);
      return handle;
  };
  const host: BrowserPaneHost = {
    create,
    createPaneSurface: () => ({
      create: (...args) => host.create(...args),
      add: () => undefined,
      remove: () => undefined,
      setBounds: () => undefined,
      attach: () => undefined,
      detach: () => undefined,
      raise: (handle) => handle.raise?.(),
      dispose: () => undefined,
    }),
  };
  return { handles, host, presentationEvents };
}

function createSessionStore() {
  let value: string | undefined;
  return new BrowserPaneSessionStore({
    storage: {
      read: () => value,
      write: (next) => {
        value = next;
      },
    },
    protector: {
      supported: true,
      encrypt: (plain) => Buffer.from(plain).toString("base64"),
      decrypt: (cipher) => Buffer.from(cipher, "base64").toString(),
    },
    debounceMs: 0,
  });
}

const bounds = { x: 0, y: 0, width: 600, height: 400 };

describe("BrowserPaneController.openLink", () => {
  test("reloads exact active and background tabs while preserving their identity", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const first = await controller.open("browser:one", bounds, "https://one.test/");
    const second = await controller.createTab("browser:one", "https://two.test/");
    const firstHandle = fake.handles.get(first.activeTabId);
    const secondHandle = fake.handles.get(second.activeTabId);
    if (!(firstHandle && secondHandle)) throw new Error("expected browser handles");
    firstHandle.loads.length = 0;
    secondHandle.loads.length = 0;

    const active = controller.openLink("browser:one", "https://two.test/", "reload-existing");
    await Promise.resolve();
    expect(active.activeTabId).toBe(second.activeTabId);
    expect(secondHandle.loads).toEqual(["https://two.test/"]);

    const background = controller.openLink("browser:one", "https://one.test/", "reload-existing");
    await Promise.resolve();
    expect(background.activeTabId).toBe(first.activeTabId);
    expect(background.tabs).toHaveLength(2);
    expect(firstHandle.loads).toEqual(["https://one.test/"]);
  });

  test("raises a selected background surface after layout and before invalidating it", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const first = await controller.open("browser:one", bounds, "https://one.test/");
    const second = await controller.createTab("browser:one", "https://two.test/");
    fake.presentationEvents.length = 0;

    controller.openLink("browser:one", "https://one.test/", "reload-existing");

    expect(fake.presentationEvents).toEqual([
      `load:${first.activeTabId}:https://one.test/`,
      `visible:${second.activeTabId}:false`,
      `visible:${first.activeTabId}:true`,
      `raise:${first.activeTabId}`,
      `invalidate:${first.activeTabId}`,
    ]);
  });

  test("uses the same native presentation order for direct tab selection", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const first = await controller.open("browser:one", bounds, "https://one.test/");
    const second = await controller.createTab("browser:one", "https://two.test/");
    fake.presentationEvents.length = 0;

    controller.selectTab("browser:one", first.activeTabId);

    expect(fake.presentationEvents).toEqual([
      `visible:${second.activeTabId}:false`,
      `visible:${first.activeTabId}:true`,
      `raise:${first.activeTabId}`,
      `invalidate:${first.activeTabId}`,
    ]);
  });

  test("activates and invalidates the sibling after closing the active tab", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const first = await controller.open("browser:one", bounds, "https://one.test/");
    const second = await controller.createTab("browser:one", "https://two.test/");
    fake.presentationEvents.length = 0;

    const closed = await controller.closeTab("browser:one", second.activeTabId);

    expect(closed.activeTabId).toBe(first.activeTabId);
    expect(fake.presentationEvents).toEqual([
      `visible:${second.activeTabId}:false`,
      `visible:${first.activeTabId}:true`,
      `raise:${first.activeTabId}`,
      `invalidate:${first.activeTabId}`,
    ]);
  });

  test("does not raise a selected surface while its context is occluded", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const first = await controller.open("browser:one", bounds, "https://one.test/");
    const second = await controller.createTab("browser:one", "https://two.test/");
    controller.layout("browser:one", bounds, "occluded");
    fake.presentationEvents.length = 0;

    controller.selectTab("browser:one", first.activeTabId);

    expect(fake.presentationEvents).toEqual([
      `visible:${second.activeTabId}:false`,
      `visible:${first.activeTabId}:false`,
    ]);
  });

  test("focuses exact active and background tabs without reloading", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const first = await controller.open("browser:one", bounds, "https://one.test/");
    const second = await controller.createTab("browser:one", "https://two.test/");
    const firstHandle = fake.handles.get(first.activeTabId);
    const secondHandle = fake.handles.get(second.activeTabId);
    if (!(firstHandle && secondHandle)) throw new Error("expected browser handles");
    firstHandle.loads.length = 0;
    secondHandle.loads.length = 0;

    expect(controller.openLink("browser:one", "https://two.test/", "focus-existing").activeTabId).toBe(
      second.activeTabId,
    );
    expect(controller.openLink("browser:one", "https://one.test/", "focus-existing").activeTabId).toBe(
      first.activeTabId,
    );
    expect(firstHandle.loads).toEqual([]);
    expect(secondHandle.loads).toEqual([]);
  });

  test("reuses an active originless tab and creates when the active tab has an origin", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const blank = await controller.open("browser:one", bounds);

    const reused = controller.openLink("browser:one", "https://one.test/", "focus-existing");
    await Promise.resolve();
    expect(reused.activeTabId).toBe(blank.activeTabId);
    expect(reused.tabs).toHaveLength(1);

    const created = controller.openLink("browser:one", "https://two.test/", "focus-existing");
    expect(created.activeTabId).not.toBe(blank.activeTabId);
    expect(created.tabs).toHaveLength(2);
    expect(created.tabs[1]?.url).toBe("https://two.test/");
  });

  test("publishes and persists the atomic result", async () => {
    const fake = createFakeHost();
    const store = createSessionStore();
    const events: unknown[] = [];
    const controller = new BrowserPaneController(fake.host, {
      onStateChanged: (snapshot) => events.push(snapshot),
      sessionStore: store,
    });
    const opened = await controller.open("browser:one", bounds, "https://one.test/");
    events.length = 0;

    const linked = controller.openLink("browser:one", "https://two.test/", "reload-existing");

    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toEqual(linked);
    expect(store.get("browser:one")).toMatchObject({
      activeTabId: linked.activeTabId,
      tabs: [
        { id: opened.activeTabId, url: "https://one.test/" },
        { id: linked.activeTabId, url: "https://two.test/" },
      ],
    });
  });

  test("retains the requested URL across asynchronous and synchronous load failures", async () => {
    const asyncUrl = "https://async-failure.test/";
    const syncUrl = "https://sync-failure.test/";
    const fake = createFakeHost({ asyncFailures: new Set([asyncUrl]), syncFailures: new Set([syncUrl]) });
    const store = createSessionStore();
    const controller = new BrowserPaneController(fake.host, { sessionStore: store });
    const blank = await controller.open("browser:one", bounds);

    const asyncResult = controller.openLink("browser:one", asyncUrl, "reload-existing");
    await Promise.resolve();
    expect(asyncResult.tabs).toEqual([expect.objectContaining({ id: blank.activeTabId, url: asyncUrl })]);
    expect(controller.getState("browser:one")?.tabs[0]?.url).toBe(asyncUrl);

    const syncResult = controller.openLink("browser:one", syncUrl, "reload-existing");
    await Promise.resolve();
    expect(syncResult.tabs).toEqual([expect.objectContaining({ id: blank.activeTabId, url: syncUrl })]);
    expect(controller.getState("browser:one")?.tabs[0]?.url).toBe(syncUrl);
    expect(fake.handles.get(blank.activeTabId)?.closed).toBe(false);
    expect(store.get("browser:one")?.tabs[0]?.url).toBe(syncUrl);
  });

  test("retains a failed link when reusing a nonblank originless tab", async () => {
    const targetUrl = "https://failure.test/";
    const fake = createFakeHost({ asyncFailures: new Set([targetUrl]) });
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", bounds);
    const handle = fake.handles.get(opened.activeTabId);
    if (!handle) throw new Error("expected browser handle");
    await handle.load("data:text/plain,existing");

    const linked = controller.openLink("browser:one", targetUrl, "reload-existing");
    await Promise.resolve();

    expect(linked.tabs).toEqual([expect.objectContaining({ id: opened.activeTabId, url: targetUrl })]);
    expect(controller.getState("browser:one")?.tabs[0]?.url).toBe(targetUrl);
  });

  test("retains a failed link after creating a new tab", async () => {
    const targetUrl = "https://failure.test/";
    const fake = createFakeHost({ syncFailures: new Set([targetUrl]) });
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", bounds, "https://one.test/");

    const linked = controller.openLink("browser:one", targetUrl, "reload-existing");

    expect(linked.activeTabId).not.toBe(opened.activeTabId);
    expect(linked.tabs).toHaveLength(2);
    expect(linked.tabs[1]).toEqual(expect.objectContaining({ id: linked.activeTabId, url: targetUrl }));
    expect(fake.handles.get(linked.activeTabId)?.closed).toBe(false);
  });

  test("rejects unsafe links, invalid modes, and over-limit creation without mutation", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host, { maxTabs: 1 });
    const opened = await controller.open("browser:one", bounds, "https://one.test/");
    const handle = fake.handles.get(opened.activeTabId);
    if (!handle) throw new Error("expected browser handle");
    handle.loads.length = 0;

    expect(() => controller.openLink("browser:one", "http://192.168.1.2/", "reload-existing")).toThrow();
    expect(() => controller.openLink("browser:one", "https://user:pass@example.com/", "reload-existing")).toThrow();
    expect(() => controller.openLink("browser:one", "https://two.test/", "invalid" as never)).toThrow(
      "open-link mode is invalid",
    );
    expect(() => controller.openLink("browser:one", "https://two.test/", "focus-existing")).toThrow("tab limit");
    expect(controller.getState("browser:one")).toEqual(opened);
    expect(handle.loads).toEqual([]);

    expect(controller.openLink("browser:one", "https://one.test/", "focus-existing")).toEqual(opened);
  });
});
