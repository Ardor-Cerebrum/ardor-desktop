import { describe, expect, mock, test } from "bun:test";

import type { BrowserHostCallbacks, BrowserPaneHost, BrowserTabHandle } from "./browser-surface";
import { BrowserPaneController } from "./pane-controller";
import { BrowserPaneSessionStore } from "./pane-session-store";

function createFakeHost(
  failure?: { contextId: string; operation: "add" | "remove"; remaining?: number },
  failedLoadUrl?: string,
) {
  const partitions: string[] = [];
  const surfaceEvents: string[] = [];
  const handleIds = new WeakMap<BrowserTabHandle, string>();
  const handles = new Map<
    string,
    BrowserTabHandle & {
      visible: boolean;
      backgroundThrottling: boolean;
      bounds: unknown;
      closed: boolean;
      favicon: string | undefined;
      invalidations: number;
      inputs: unknown[];
      loads: number;
      navigate(url: string): void;
      stops: number;
      colorScheme: string | null;
      viewport: unknown;
    }
  >();
  const callbacks = new Map<string, BrowserHostCallbacks>();
  const create: BrowserPaneHost["create"] = (tabId, partition, onUrlChanged, tabCallbacks = {}) => {
    partitions.push(partition);
    let currentUrl = "about:blank";
    const handle: BrowserTabHandle & {
      visible: boolean;
      backgroundThrottling: boolean;
      bounds: unknown;
      closed: boolean;
      favicon: string | undefined;
      invalidations: number;
      inputs: unknown[];
      loads: number;
      navigate(url: string): void;
      stops: number;
      colorScheme: string | null;
      viewport: unknown;
    } = {
      visible: false,
      backgroundThrottling: true,
      bounds: null,
      closed: false,
      favicon: undefined,
      invalidations: 0,
      inputs: [],
      loads: 0,
      stops: 0,
      colorScheme: null,
      viewport: null,
      load: async (url) => {
        handle.loads += 1;
        currentUrl = url;
        tabCallbacks.onStateChanged?.();
        if (url === failedLoadUrl) throw new Error("injected page load failure");
      },
      navigate: (url) => {
        currentUrl = url;
        onUrlChanged?.(url);
        tabCallbacks.onStateChanged?.();
      },
      url: () => currentUrl,
      title: () => (currentUrl === "about:blank" ? "" : new URL(currentUrl).hostname),
      faviconUrl: () => handle.favicon,
      canGoBack: () => currentUrl !== "about:blank",
      canGoForward: () => false,
      isLoading: () => false,
      setBounds: (bounds) => {
        handle.bounds = bounds;
      },
      setVisible: (visible) => {
        handle.visible = visible;
      },
      setBackgroundThrottling: (enabled) => {
        handle.backgroundThrottling = enabled;
      },
      invalidate: () => {
        handle.invalidations += 1;
      },
      close: () => {
        handle.visible = false;
        handle.closed = true;
      },
      capturePage: async () => `data:image/png;base64,${tabId}`,
      goBack: () => true,
      goForward: () => false,
      reload: () => true,
      stop: () => {
        handle.stops += 1;
        return true;
      },
      sendCommand: async () => ({ result: { ok: true } }),
      setColorScheme: async (colorScheme) => {
        handle.colorScheme = colorScheme;
        return true;
      },
      setViewport: async (viewport) => {
        handle.viewport = viewport;
        return true;
      },
      input: (input) => {
        handle.inputs.push(input);
        return true;
      },
    };
    handles.set(tabId, handle);
    handleIds.set(handle, tabId);
    callbacks.set(tabId, tabCallbacks);
    return handle;
  };
  const host: BrowserPaneHost = {
    create,
    createPaneSurface: (contextId) => {
      const surfaceHandles = new Set<BrowserTabHandle>();
      let attached = false;
      let disposed = false;
      return {
        create: (...args) => {
          const handle = host.create(...args);
          surfaceHandles.add(handle);
          surfaceEvents.push(`create:${contextId}:${args[0]}`);
          return handle;
        },
        add: (handle) => {
          if (
            failure?.contextId === contextId &&
            failure.operation === "add" &&
            (failure.remaining ?? 1) > 0
          ) {
            failure.remaining = (failure.remaining ?? 1) - 1;
            throw new Error("injected surface add failure");
          }
          surfaceHandles.add(handle);
          surfaceEvents.push(`add:${contextId}:${handleIds.get(handle) ?? "tab"}`);
        },
        remove: (handle) => {
          if (
            failure?.contextId === contextId &&
            failure.operation === "remove" &&
            (failure.remaining ?? 1) > 0
          ) {
            failure.remaining = (failure.remaining ?? 1) - 1;
            throw new Error("injected surface remove failure");
          }
          surfaceHandles.delete(handle);
          surfaceEvents.push(`remove:${contextId}:${handleIds.get(handle) ?? "tab"}`);
        },
        setBounds: (bounds) => {
          for (const handle of surfaceHandles) handle.setBounds(bounds);
          surfaceEvents.push(`bounds:${contextId}`);
        },
        attach: () => {
          if (attached || disposed) return;
          attached = true;
          surfaceEvents.push(`attach:${contextId}`);
        },
        detach: () => {
          if (!attached) return;
          attached = false;
          surfaceEvents.push(`detach:${contextId}`);
        },
        raise: (handle) => {
          if (attached && surfaceHandles.has(handle)) {
            surfaceEvents.push(`raise:${contextId}:${handleIds.get(handle) ?? "tab"}`);
            handle.raise?.();
          }
        },
        dispose: () => {
          if (disposed) return;
          if (attached) {
            attached = false;
            surfaceEvents.push(`detach:${contextId}`);
          }
          disposed = true;
          surfaceEvents.push(`dispose:${contextId}`);
        },
      };
    },
  };
  return { callbacks, handles, host, partitions, surfaceEvents };
}

function createSessionStore() {
  let value: string | undefined;
  const storage = {
    read: () => value,
    write: (next: string) => {
      value = next;
    },
  };
  const protector = {
    supported: true,
    encrypt: (plain: string) => Buffer.from(plain, "utf8").toString("base64"),
    decrypt: (cipher: string) => Buffer.from(cipher, "base64").toString("utf8"),
  };
  return {
    storage,
    create: () => new BrowserPaneSessionStore({ storage, protector, debounceMs: 0 }),
  };
}

describe("BrowserPaneController", () => {
  test("retains an initially failed page for native retry and error rendering", async () => {
    const url = "https://unreachable.example/";
    const fake = createFakeHost(undefined, url);
    const controller = new BrowserPaneController(fake.host);

    const opened = await controller.open(
      "browser:session",
      { x: 0, y: 0, width: 600, height: 400 },
      url,
    );

    expect(opened.tabs).toHaveLength(1);
    expect(opened.tabs[0]?.url).toBe(url);
    expect(fake.handles.get(opened.activeTabId)?.closed).toBe(false);
  });

  test("forwards a blocked navigation with its owning context and live tab", async () => {
    const fake = createFakeHost();
    const onNavigationBlocked = mock(() => undefined);
    const controller = new BrowserPaneController(fake.host, { onNavigationBlocked });
    const opened = await controller.open("browser:session", { x: 0, y: 0, width: 600, height: 400 });

    fake.callbacks
      .get(opened.activeTabId)
      ?.onNavigationBlocked?.("example.test", "credentials");
    fake.callbacks
      .get(opened.activeTabId)
      ?.onNavigationBlocked?.("example.test", "credentials");

    expect(onNavigationBlocked).toHaveBeenCalledWith({
      contextId: "browser:session",
      tabId: opened.activeTabId,
      hostname: "example.test",
      reason: "credentials",
    });
    expect(onNavigationBlocked).toHaveBeenCalledTimes(1);
  });

  test("forwards denied media access once per context throttle window", async () => {
    const fake = createFakeHost();
    const onMediaPermissionDenied = mock(() => undefined);
    const controller = new BrowserPaneController(fake.host, { onMediaPermissionDenied });
    const opened = await controller.open("browser:session", { x: 0, y: 0, width: 600, height: 400 });
    const callback = fake.callbacks.get(opened.activeTabId)?.onMediaPermissionDenied;

    callback?.(["camera"]);
    callback?.(["microphone"]);

    expect(onMediaPermissionDenied).toHaveBeenCalledWith({
      contextId: "browser:session",
      tabId: opened.activeTabId,
      mediaTypes: ["camera"],
    });
    expect(onMediaPermissionDenied).toHaveBeenCalledTimes(1);
  });

  test("toggles selection on one tab and forwards the selected element with its live owner", async () => {
    const fake = createFakeHost();
    const onElementSelected = mock(() => undefined);
    const controller = new BrowserPaneController(fake.host, { onElementSelected });
    const opened = await controller.open("browser:session", { x: 0, y: 0, width: 600, height: 400 });
    const setElementSelection = mock(async () => true);
    const handle = fake.handles.get(opened.activeTabId);
    if (handle) handle.setElementSelection = setElementSelection;
    const selection = {
      tagName: "button",
      classes: ["primary"],
      attributes: {},
      computedStyles: {},
      boundingBox: { x: 1, y: 2, width: 3, height: 4 },
      screenshot: "png",
    };

    expect(await controller.toggleElementSelection("browser:session", opened.activeTabId, true)).toBe(true);
    fake.callbacks.get(opened.activeTabId)?.onElementSelected?.(selection);

    expect(setElementSelection).toHaveBeenCalledWith(true);
    expect(onElementSelected).toHaveBeenCalledWith({
      contextId: "browser:session",
      tabId: opened.activeTabId,
      selection,
    });
  });

  test("stops the active tab load through the pane control contract", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open(
      "browser:session",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://example.com/",
    );

    expect(await controller.control("browser:session", opened.activeTabId, "stop")).toBe(true);
    expect(fake.handles.get(opened.activeTabId)?.stops).toBe(1);
  });

  test("creates a context with the partition resolved from its profile scope", async () => {
    const fake = createFakeHost();
    const scopes: unknown[] = [];
    const controller = new BrowserPaneController(fake.host, {
      resolvePartition: (scope) => {
        scopes.push(scope);
        return "persist:ardor-browser-session-0123456789ab";
      },
    });

    await controller.claim(
      "browser:session",
      "surface:first",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://example.com/",
      "visible",
      { workspaceId: "workspace-a", sessionId: "session-a" },
    );

    expect(scopes).toEqual([{ workspaceId: "workspace-a", sessionId: "session-a" }]);
    expect(fake.partitions).toEqual(["persist:ardor-browser-session-0123456789ab"]);
  });

  test("releases a hidden context without destroying it and rejects stale claimants", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.claim(
      "browser:session",
      "surface:first",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://example.com/",
    );
    const handle = fake.handles.get(opened.activeTabId);

    expect(controller.release("browser:session", "surface:stale")).toBe(false);
    expect(handle).toMatchObject({ closed: false, visible: true });
    await expect(
      controller.claim(
        "browser:session",
        "surface:second",
        { x: 10, y: 20, width: 700, height: 500 },
      ),
    ).rejects.toThrow("claimed by another surface");

    expect(controller.release("browser:session", "surface:first")).toBe(true);
    expect(controller.getState("browser:session")).toEqual(opened);
    expect(handle).toMatchObject({ closed: false, visible: false });

    await controller.claim(
      "browser:session",
      "surface:second",
      { x: 10, y: 20, width: 700, height: 500 },
    );
    expect(controller.release("browser:session", "surface:first")).toBe(false);
    expect(handle).toMatchObject({ closed: false, visible: true, invalidations: 1 });
  });

  test("moves a live tab into a new context without closing or reloading its WebContents", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const source = await controller.open("browser:source", { x: 0, y: 0, width: 600, height: 400 }, "https://example.com/");
    const tabId = source.activeTabId;
    const handle = fake.handles.get(tabId);

    const moved = await controller.moveTab(
      "browser:source",
      tabId,
      "browser:destination",
    );

    expect(moved.source).toBeNull();
    expect(moved.destination).toMatchObject({
      contextId: "browser:destination",
      activeTabId: tabId,
      tabs: [{ id: tabId, url: "https://example.com/", active: true }],
    });
    expect(controller.getState("browser:source")).toBeNull();
    expect(fake.handles.get(tabId)).toBe(handle);
    expect(handle).toMatchObject({ closed: false, visible: false, backgroundThrottling: true });
  });

  test("surfaces favicon state and retains it when moving a live tab", async () => {
    const fake = createFakeHost();
    const stateChanges: string[] = [];
    const controller = new BrowserPaneController(fake.host, {
      onStateChanged: (snapshot) => stateChanges.push(snapshot.contextId),
    });
    const source = await controller.open(
      "browser:source",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://example.com/",
    );
    const handle = fake.handles.get(source.activeTabId);
    if (!handle) throw new Error("expected browser handle");
    const faviconUrl = `data:image/png;base64,${Buffer.from("icon").toString("base64")}`;
    stateChanges.length = 0;

    handle.favicon = faviconUrl;
    fake.callbacks.get(source.activeTabId)?.onStateChanged?.();
    expect(controller.getState("browser:source")?.tabs[0]?.faviconUrl).toBe(faviconUrl);
    expect(stateChanges).toEqual(["browser:source"]);

    const moved = controller.moveTab("browser:source", source.activeTabId, "browser:destination");
    expect(moved.destination.tabs[0]?.faviconUrl).toBe(faviconUrl);
    expect(fake.handles.get(source.activeTabId)).toBe(handle);
    expect(handle.closed).toBe(false);
  });

  test("commits a prepared live-tab transfer without reloading its WebContents", async () => {
    const fake = createFakeHost();
    const session = createSessionStore();
    const store = session.create();
    const stateChanges: string[] = [];
    const controller = new BrowserPaneController(fake.host, {
      onStateChanged: (snapshot) => stateChanges.push(snapshot.contextId),
      sessionStore: store,
    });
    const source = await controller.open(
      "browser:source",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://example.com/",
    );
    const handle = fake.handles.get(source.activeTabId);
    stateChanges.length = 0;

    const prepared = controller.beginTabTransfer("browser:source", source.activeTabId, "browser:destination");

    expect(prepared.transferId).toMatch(/^transfer:/);
    expect(prepared.source).toBeNull();
    expect(prepared.destination).toMatchObject({
      contextId: "browser:destination",
      tabs: [{ id: source.activeTabId, url: "https://example.com/" }],
    });
    expect(controller.getState("browser:source")).toMatchObject({ activeTabId: source.activeTabId, tabs: [] });
    expect(handle).toMatchObject({ closed: false, visible: false });
    expect(session.create().get("browser:source")?.tabs).toEqual([
      { id: source.activeTabId, url: "https://example.com/" },
    ]);
    expect(session.create().get("browser:destination")).toBeUndefined();
    expect(stateChanges).toEqual([]);
    await expect(
      controller.claim(
        "browser:destination",
        "surface:destination",
        { x: 610, y: 0, width: 600, height: 400 },
      ),
    ).rejects.toThrow("destination is not ready");

    const committed = controller.commitTabTransfer(prepared.transferId);

    expect(committed.source).toBeNull();
    expect(committed.destination).toEqual(prepared.destination);
    expect(controller.getState("browser:source")).toBeNull();
    expect(fake.handles.get(source.activeTabId)).toBe(handle);
    expect(handle?.closed).toBe(false);
    expect(session.create().get("browser:source")).toBeUndefined();
    expect(session.create().get("browser:destination")?.tabs).toEqual([
      { id: source.activeTabId, url: "https://example.com/" },
    ]);
    expect(stateChanges).toEqual(["browser:destination"]);
    expect(fake.surfaceEvents).toEqual(
      expect.arrayContaining([
        `remove:browser:source:${source.activeTabId}`,
        `add:browser:destination:${source.activeTabId}`,
        "detach:browser:source",
        "dispose:browser:source",
      ]),
    );
    expect(() => controller.commitTabTransfer(prepared.transferId)).toThrow("unavailable");
  });

  test("rolls a prepared transfer back to the exact source order and active tab", async () => {
    const fake = createFakeHost();
    const session = createSessionStore();
    const store = session.create();
    const controller = new BrowserPaneController(fake.host, { sessionStore: store });
    const first = await controller.open(
      "browser:source",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://one.test/",
    );
    const second = await controller.createTab("browser:source", "https://two.test/");
    const third = await controller.createTab("browser:source", "https://three.test/");
    controller.selectTab("browser:source", second.activeTabId);
    const before = controller.getState("browser:source");
    const handlesBefore = new Map(fake.handles);

    const prepared = controller.beginTabTransfer("browser:source", second.activeTabId, "browser:destination");
    expect(prepared.source?.tabs.map((tab) => tab.id)).toEqual([first.activeTabId, third.activeTabId]);
    expect(prepared.source?.activeTabId).toBe(third.activeTabId);
    expect(() => controller.selectTab("browser:source", first.activeTabId)).toThrow("pending tab transfer");

    const rolledBack = controller.rollbackTabTransfer(prepared.transferId);

    expect(rolledBack).toEqual(before);
    expect(rolledBack.tabs.map((tab) => tab.id)).toEqual([first.activeTabId, second.activeTabId, third.activeTabId]);
    expect(rolledBack.activeTabId).toBe(second.activeTabId);
    expect(controller.getState("browser:destination")).toBeNull();
    for (const [id, handle] of handlesBefore) {
      expect(fake.handles.get(id)).toBe(handle);
      expect(handle.closed).toBe(false);
    }
    expect(session.create().get("browser:source")?.tabs.map((tab) => tab.id)).toEqual([
      first.activeTabId,
      second.activeTabId,
      third.activeTabId,
    ]);
    expect(session.create().get("browser:destination")).toBeUndefined();
    expect(fake.surfaceEvents).toEqual(
      expect.arrayContaining([
        `remove:browser:source:${second.activeTabId}`,
        `add:browser:destination:${second.activeTabId}`,
        `remove:browser:destination:${second.activeTabId}`,
        `add:browser:source:${second.activeTabId}`,
        "dispose:browser:destination",
      ]),
    );
    expect(() => controller.rollbackTabTransfer("transfer:not-valid")).toThrow("id is invalid");
  });

  test("keeps live tab transfer state usable when native reparenting fails", async () => {
    for (const failure of [
      { contextId: "browser:source", operation: "remove" as const },
      { contextId: "browser:destination", operation: "add" as const },
    ]) {
      const fake = createFakeHost(failure);
      const controller = new BrowserPaneController(fake.host);
      const source = await controller.open(
        "browser:source",
        { x: 0, y: 0, width: 600, height: 400 },
        "https://example.test/",
      );

      expect(() =>
        controller.beginTabTransfer(
          "browser:source",
          source.activeTabId,
          "browser:destination",
        ),
      ).toThrow("injected surface");
      expect(controller.getState("browser:source")).toEqual(source);
      expect(controller.getState("browser:destination")).toBeNull();
      expect(fake.handles.get(source.activeTabId)).toMatchObject({ closed: false, visible: true });
      expect(() => controller.selectTab("browser:source", source.activeTabId)).not.toThrow();
    }
  });

  test("keeps a prepared transfer retryable when reverse reparenting fails", async () => {
    const failure = { contextId: "browser:source", operation: "add" as const, remaining: 0 };
    const fake = createFakeHost(failure);
    const controller = new BrowserPaneController(fake.host);
    const source = await controller.open(
      "browser:source",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://example.test/",
    );
    const prepared = controller.beginTabTransfer(
      "browser:source",
      source.activeTabId,
      "browser:destination",
    );

    failure.remaining = 1;
    expect(() => controller.rollbackTabTransfer(prepared.transferId)).toThrow(
      "injected surface add failure",
    );
    expect(controller.getState("browser:destination")?.tabs).toHaveLength(1);
    expect(() => controller.selectTab("browser:source", source.activeTabId)).toThrow(
      "pending tab transfer",
    );

    expect(controller.rollbackTabTransfer(prepared.transferId)).toEqual(source);
    expect(controller.getState("browser:destination")).toBeNull();
  });

  test("rolls back outstanding transfers before semantic close or disposal", async () => {
    const sourceCloseFake = createFakeHost();
    const sourceCloseSession = createSessionStore();
    const sourceCloseController = new BrowserPaneController(sourceCloseFake.host, {
      sessionStore: sourceCloseSession.create(),
    });
    const sourceClose = await sourceCloseController.open(
      "browser:source-close",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://source-close.test/",
    );
    sourceCloseController.beginTabTransfer(
      "browser:source-close",
      sourceClose.activeTabId,
      "browser:source-close-destination",
    );

    expect(sourceCloseController.closeContext("browser:source-close")).toBe(true);
    expect(sourceCloseController.getState("browser:source-close")).toBeNull();
    expect(sourceCloseController.getState("browser:source-close-destination")).toBeNull();
    expect(sourceCloseFake.handles.get(sourceClose.activeTabId)?.closed).toBe(true);
    expect(sourceCloseSession.create().get("browser:source-close")).toBeUndefined();
    expect(sourceCloseFake.surfaceEvents).toEqual(
      expect.arrayContaining([
        "dispose:browser:source-close-destination",
        "dispose:browser:source-close",
      ]),
    );

    const destinationCloseFake = createFakeHost();
    const destinationCloseSession = createSessionStore();
    const destinationCloseController = new BrowserPaneController(destinationCloseFake.host, {
      sessionStore: destinationCloseSession.create(),
    });
    const destinationClose = await destinationCloseController.open(
      "browser:destination-close-source",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://destination-close.test/",
    );
    destinationCloseController.beginTabTransfer(
      "browser:destination-close-source",
      destinationClose.activeTabId,
      "browser:destination-close",
    );

    expect(destinationCloseController.closeContext("browser:destination-close")).toBe(true);
    expect(destinationCloseController.getState("browser:destination-close")).toBeNull();
    expect(destinationCloseController.getState("browser:destination-close-source")).toEqual(destinationClose);
    expect(destinationCloseFake.handles.get(destinationClose.activeTabId)?.closed).toBe(false);
    expect(destinationCloseFake.surfaceEvents).toContain("dispose:browser:destination-close");

    const disposeFake = createFakeHost();
    const disposeSession = createSessionStore();
    const disposeController = new BrowserPaneController(disposeFake.host, { sessionStore: disposeSession.create() });
    const disposing = await disposeController.open(
      "browser:dispose-source",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://dispose.test/",
    );
    disposeController.beginTabTransfer("browser:dispose-source", disposing.activeTabId, "browser:dispose-destination");

    disposeController.dispose();
    expect(disposeController.getState("browser:dispose-source")).toBeNull();
    expect(disposeController.getState("browser:dispose-destination")).toBeNull();
    expect(disposeFake.handles.get(disposing.activeTabId)?.closed).toBe(true);
    expect(disposeSession.create().get("browser:dispose-source")?.tabs).toEqual([
      { id: disposing.activeTabId, url: "https://dispose.test/" },
    ]);
    expect(disposeSession.create().get("browser:dispose-destination")).toBeUndefined();
    expect(disposeFake.surfaceEvents).toEqual(
      expect.arrayContaining([
        "dispose:browser:dispose-destination",
        "dispose:browser:dispose-source",
      ]),
    );
  });

  test("preserves two live pages after moving one tab, switching sessions, and reclaiming both panes", async () => {
    const fake = createFakeHost();
    const session = createSessionStore();
    const store = session.create();
    const controller = new BrowserPaneController(fake.host, { sessionStore: store });
    const sourceContextId = "browser:session-a:source";
    const destinationContextId = "browser:session-a:detached";
    const otherContextId = "browser:session-b:source";
    const sourceBounds = { x: 0, y: 0, width: 600, height: 400 };
    const destinationBounds = { x: 610, y: 0, width: 600, height: 400 };

    const opened = await controller.claim(
      sourceContextId,
      "surface:source:first-mount",
      sourceBounds,
      "https://first.test/",
    );
    const firstTabId = opened.activeTabId;
    const withSecondTab = await controller.createTab(sourceContextId, "https://second.test/");
    const secondTabId = withSecondTab.activeTabId;
    const firstHandle = fake.handles.get(firstTabId);
    const secondHandle = fake.handles.get(secondTabId);
    if (!(firstHandle && secondHandle)) throw new Error("expected two browser handles");

    let unexpectedLoads = 0;
    for (const handle of [firstHandle, secondHandle]) {
      const load = handle.load;
      handle.load = async (url) => {
        unexpectedLoads += 1;
        await load(url);
      };
    }

    const moved = controller.moveTab(sourceContextId, secondTabId, destinationContextId);
    expect(moved.source?.tabs).toEqual([
      expect.objectContaining({ active: true, id: firstTabId, url: "https://first.test/" }),
    ]);
    expect(moved.destination.tabs).toEqual([
      expect.objectContaining({ active: true, id: secondTabId, url: "https://second.test/" }),
    ]);
    expect(firstHandle).toMatchObject({ closed: false, invalidations: 1, visible: true });

    await controller.claim(
      destinationContextId,
      "surface:destination:first-mount",
      destinationBounds,
    );
    expect(secondHandle).toMatchObject({ closed: false, invalidations: 1, visible: true });

    expect(controller.release(sourceContextId, "surface:source:first-mount")).toBe(true);
    expect(controller.release(destinationContextId, "surface:destination:first-mount")).toBe(true);
    expect(firstHandle).toMatchObject({ closed: false, visible: false });
    expect(secondHandle).toMatchObject({ closed: false, visible: false });

    store.flush();
    const persisted = session.create();
    expect(persisted.get(sourceContextId)?.tabs).toEqual([{ id: firstTabId, url: "https://first.test/" }]);
    expect(persisted.get(destinationContextId)?.tabs).toEqual([
      { id: secondTabId, url: "https://second.test/" },
    ]);

    const other = await controller.claim(
      otherContextId,
      "surface:other",
      { x: 0, y: 0, width: 900, height: 700 },
      "https://other.test/",
    );
    expect(fake.handles.get(other.activeTabId)?.visible).toBe(true);
    expect(controller.release(otherContextId, "surface:other")).toBe(true);

    const reclaimedSource = await controller.claim(
      sourceContextId,
      "surface:source:second-mount",
      sourceBounds,
    );
    const reclaimedDestination = await controller.claim(
      destinationContextId,
      "surface:destination:second-mount",
      destinationBounds,
    );

    expect(reclaimedSource.tabs).toEqual([
      expect.objectContaining({ active: true, id: firstTabId, url: "https://first.test/" }),
    ]);
    expect(reclaimedDestination.tabs).toEqual([
      expect.objectContaining({ active: true, id: secondTabId, url: "https://second.test/" }),
    ]);
    expect(fake.handles.get(firstTabId)).toBe(firstHandle);
    expect(fake.handles.get(secondTabId)).toBe(secondHandle);
    expect(unexpectedLoads).toBe(0);
    expect(firstHandle).toMatchObject({
      bounds: sourceBounds,
      closed: false,
      invalidations: 2,
      visible: true,
    });
    expect(secondHandle).toMatchObject({
      bounds: destinationBounds,
      closed: false,
      invalidations: 2,
      visible: true,
    });

    expect(controller.release(sourceContextId, "surface:source:first-mount")).toBe(false);
    expect(controller.release(destinationContextId, "surface:destination:first-mount")).toBe(false);
    expect(firstHandle.visible).toBe(true);
    expect(secondHandle.visible).toBe(true);
  });

  test("restores saved tabs into the current mount bounds and presentation after a process restart", async () => {
    const firstFake = createFakeHost();
    const session = createSessionStore();
    const firstStore = session.create();
    const firstController = new BrowserPaneController(firstFake.host, { sessionStore: firstStore });
    const first = await firstController.open("browser:restore", { x: 0, y: 0, width: 600, height: 400 }, "https://fallback.test/");
    const second = await firstController.createTab("browser:restore", "https://second.test/");
    firstController.selectTab("browser:restore", first.activeTabId);
    firstController.layout("browser:restore", { x: 10, y: 20, width: 700, height: 500 }, "occluded");
    firstStore.flush();
    firstController.dispose();

    const restoredFake = createFakeHost();
    const restoredController = new BrowserPaneController(restoredFake.host, { sessionStore: session.create() });
    const restored = await restoredController.open(
      "browser:restore",
      { x: 9, y: 9, width: 9, height: 9 },
      "https://should-not-win.test/",
    );

    expect(restored.tabs.map((tab) => tab.url)).toEqual(["https://fallback.test/", "https://second.test/"]);
    expect(restored.activeTabId).toBe(restored.tabs[0]?.id);
    expect(restoredFake.handles.get(restored.activeTabId)?.bounds).toMatchObject({ x: 9, y: 9, width: 9, height: 9 });
    expect(restoredFake.handles.get(restored.activeTabId)?.visible).toBe(true);
    expect(restoredFake.handles.get(restored.activeTabId)?.backgroundThrottling).toBe(true);
    expect(second.activeTabId).not.toBe(first.activeTabId);
  });

  test("keeps the saved context when one restored page is temporarily unavailable", async () => {
    const session = createSessionStore();
    const seed = session.create();
    seed.set("browser:partial-restore", {
      activeTabId: "tab-unavailable",
      tabs: [
        { id: "tab-available", url: "https://available.test/" },
        { id: "tab-unavailable", url: "https://unavailable.test/" },
      ],
    });
    seed.flush();

    const fake = createFakeHost();
    const createHandle = fake.host.create;
    fake.host.create = (...args) => {
      const handle = createHandle(...args);
      const load = handle.load;
      handle.load = async (url) => {
        if (url === "https://unavailable.test/") {
          throw new Error("temporarily unavailable");
        }
        await load(url);
      };
      return handle;
    };
    const store = session.create();
    const controller = new BrowserPaneController(fake.host, { sessionStore: store });

    const restored = await controller.claim(
      "browser:partial-restore",
      "surface:restored",
      { x: 0, y: 0, width: 600, height: 400 },
    );

    expect(restored.activeTabId).toBe("tab-unavailable");
    expect(restored.tabs.map(({ id, url }) => ({ id, url }))).toEqual([
      { id: "tab-available", url: "https://available.test/" },
      { id: "tab-unavailable", url: "https://unavailable.test/" },
    ]);
    expect(fake.handles.get("tab-available")?.closed).toBe(false);
    expect(fake.handles.get("tab-unavailable")).toMatchObject({ closed: false, visible: true });

    store.flush();
    expect(session.create().get("browser:partial-restore")?.tabs).toEqual([
      { id: "tab-available", url: "https://available.test/" },
      { id: "tab-unavailable", url: "https://unavailable.test/" },
    ]);
  });

  test("bounds each saved tab restore without blocking sibling tabs or contexts", async () => {
    const session = createSessionStore();
    const seed = session.create();
    seed.set("browser:bounded-restore", {
      activeTabId: "tab-hanging",
      tabs: [
        { id: "tab-hanging", url: "https://hanging.test/" },
        { id: "tab-available", url: "https://available.test/" },
      ],
    });
    seed.flush();

    const fake = createFakeHost();
    const createHandle = fake.host.create;
    const startedLoads: string[] = [];
    fake.host.create = (...args) => {
      const handle = createHandle(...args);
      const load = handle.load;
      handle.load = async (url) => {
        startedLoads.push(url);
        if (url === "https://hanging.test/") {
          await new Promise<void>(() => undefined);
          return;
        }
        await load(url);
      };
      return handle;
    };
    const store = session.create();
    const controller = new BrowserPaneController(fake.host, {
      restoreTabTimeoutMs: 10,
      sessionStore: store,
    });

    const restoring = controller.claim(
      "browser:bounded-restore",
      "surface:restored",
      { x: 0, y: 0, width: 600, height: 400 },
    );
    await Promise.resolve();
    expect(startedLoads).toEqual(["https://hanging.test/", "https://available.test/"]);

    const other = await controller.claim(
      "browser:other-context",
      "surface:other",
      { x: 610, y: 0, width: 600, height: 400 },
      "https://other.test/",
    );
    expect(other.tabs.map((tab) => tab.url)).toEqual(["https://other.test/"]);

    const restored = await restoring;
    expect(restored.activeTabId).toBe("tab-hanging");
    expect(restored.tabs.map(({ id, url }) => ({ id, url }))).toEqual([
      { id: "tab-hanging", url: "https://hanging.test/" },
      { id: "tab-available", url: "https://available.test/" },
    ]);
    expect(fake.handles.get("tab-hanging")?.closed).toBe(false);
    expect(fake.handles.get("tab-available")?.closed).toBe(false);

    store.flush();
    expect(session.create().get("browser:bounded-restore")?.tabs).toEqual([
      { id: "tab-hanging", url: "https://hanging.test/" },
      { id: "tab-available", url: "https://available.test/" },
    ]);
  });

  test("preserves the session manifest when disposing native handles for a window close", async () => {
    const fake = createFakeHost();
    const session = createSessionStore();
    const controller = new BrowserPaneController(fake.host, { sessionStore: session.create() });
    await controller.open("browser:preserve", { x: 0, y: 0, width: 600, height: 400 }, "https://example.com/");
    const tabId = controller.getState("browser:preserve")?.activeTabId;
    controller.dispose();
    if (tabId) fake.callbacks.get(tabId)?.onDestroyed?.();

    expect(session.create().get("browser:preserve")).toMatchObject({
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", url: "https://example.com/" }],
      presentation: "visible",
    });
  });

  test("does not revive or forget a restored context when window disposal interrupts loading", async () => {
    const session = createSessionStore();
    const seed = session.create();
    seed.set("browser:interrupted", {
      activeTabId: "tab-saved",
      tabs: [{ id: "tab-saved", url: "https://example.com/" }],
    });
    seed.flush();

    const fake = createFakeHost();
    const createHandle = fake.host.create;
    let finishLoading = () => undefined;
    fake.host.create = (...args) => {
      const handle = createHandle(...args);
      handle.load = () =>
        new Promise<void>((resolve) => {
          finishLoading = resolve;
        });
      return handle;
    };
    const controller = new BrowserPaneController(fake.host, { sessionStore: session.create() });
    const opening = controller.open("browser:interrupted", { x: 0, y: 0, width: 600, height: 400 });
    await Promise.resolve();

    controller.dispose();
    finishLoading();

    await expect(opening).rejects.toThrow("browser pane is unavailable");
    expect(controller.getState("browser:interrupted")).toBeNull();
    expect(fake.handles.get("tab-saved")?.closed).toBe(true);
    expect(session.create().get("browser:interrupted")).toMatchObject({
      activeTabId: "tab-saved",
      tabs: [{ id: "tab-saved", url: "https://example.com/" }],
    });
  });

  test("forgets the session manifest only when a context is explicitly closed", async () => {
    const fake = createFakeHost();
    const session = createSessionStore();
    const controller = new BrowserPaneController(fake.host, { sessionStore: session.create() });
    await controller.open("browser:close", { x: 0, y: 0, width: 600, height: 400 }, "https://example.com/");
    controller.closeContext("browser:close");

    expect(session.create().get("browser:close")).toBeUndefined();
  });

  test("honors the controller tab limit while restoring a saved context", async () => {
    const session = createSessionStore();
    const seed = session.create();
    seed.set("browser:limited", {
      activeTabId: "tab-3",
      tabs: [
        { id: "tab-1", url: "https://one.test/" },
        { id: "tab-2", url: "https://two.test/" },
        { id: "tab-3", url: "https://three.test/" },
      ],
    });
    seed.flush();

    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host, { maxTabs: 2, sessionStore: session.create() });
    const restored = await controller.open("browser:limited", { x: 0, y: 0, width: 600, height: 400 });

    expect(restored.tabs.map((tab) => tab.url)).toEqual(["https://one.test/", "https://two.test/"]);
    expect(restored.activeTabId).toBe(restored.tabs[0]?.id);
  });

  test("keeps independent WebContents handles for tabs and switches native visibility", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 10, y: 20, width: 600, height: 400 });
    const firstId = opened.activeTabId;

    const withSecond = await controller.createTab("browser:one", "https://example.com/");
    const secondId = withSecond.activeTabId;

    expect(secondId).not.toBe(firstId);
    expect(fake.handles.get(firstId)?.visible).toBe(false);
    expect(fake.handles.get(firstId)?.backgroundThrottling).toBe(true);
    expect(fake.handles.get(secondId)?.visible).toBe(true);
    expect(fake.handles.get(secondId)?.backgroundThrottling).toBe(true);

    const selected = controller.selectTab("browser:one", firstId);
    expect(selected.activeTabId).toBe(firstId);
    expect(fake.handles.get(firstId)?.visible).toBe(true);
    expect(fake.handles.get(firstId)?.backgroundThrottling).toBe(true);
    expect(fake.handles.get(secondId)?.visible).toBe(false);
    expect(fake.handles.get(secondId)?.backgroundThrottling).toBe(true);
  });

  test("can create a context hidden without briefly presenting its native view", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open(
      "browser:hidden",
      { x: 0, y: 0, width: 0, height: 0 },
      undefined,
      "hidden",
    );

    expect(fake.handles.get(opened.activeTabId)).toMatchObject({ visible: false, backgroundThrottling: true });
  });

  test("keeps only the active tab rendering while its surface is occluded", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });
    const firstId = opened.activeTabId;
    const withSecond = await controller.createTab("browser:one", "https://example.com/");
    const secondId = withSecond.activeTabId;

    controller.layout("browser:one", { x: 0, y: 0, width: 600, height: 400 }, "occluded");
    expect(fake.handles.get(firstId)).toMatchObject({ visible: false, backgroundThrottling: true });
    expect(fake.handles.get(secondId)).toMatchObject({ visible: false, backgroundThrottling: false });

    controller.selectTab("browser:one", firstId);
    expect(fake.handles.get(firstId)).toMatchObject({ visible: false, backgroundThrottling: false });
    expect(fake.handles.get(secondId)).toMatchObject({ visible: false, backgroundThrottling: true });

    controller.layout("browser:one", { x: 0, y: 0, width: 600, height: 400 }, "hidden");
    expect(fake.handles.get(firstId)).toMatchObject({ visible: false, backgroundThrottling: true });
    expect(fake.handles.get(secondId)).toMatchObject({ visible: false, backgroundThrottling: true });
  });

  test("restores throttling before destroying a browser pane context", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    controller.layout("browser:one", { x: 0, y: 0, width: 600, height: 400 }, "occluded");
    expect(fake.handles.get(opened.activeTabId)?.backgroundThrottling).toBe(false);

    expect(controller.closeContext("browser:one")).toBe(true);
    expect(fake.handles.get(opened.activeTabId)).toMatchObject({
      closed: true,
      visible: false,
      backgroundThrottling: true,
    });
  });

  test("disposes occluded tabs without leaving background rendering enabled", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    controller.layout("browser:one", { x: 0, y: 0, width: 600, height: 400 }, "occluded");
    controller.dispose();

    expect(fake.handles.get(opened.activeTabId)).toMatchObject({
      closed: true,
      visible: false,
      backgroundThrottling: true,
    });
  });

  test("supports public HTTPS, upgrades public HTTP, and rejects private networks", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    await expect(controller.navigate("browser:one", opened.activeTabId, "http://localhost:3000/", true)).resolves.toBeDefined();
    await expect(controller.navigate("browser:one", opened.activeTabId, "https://example.com/", true)).resolves.toBeDefined();
    await expect(controller.navigate("browser:one", opened.activeTabId, "http://example.org/page", true)).resolves.toBeDefined();
    expect(fake.handles.get(opened.activeTabId)?.url()).toBe("https://example.org/page");
    await expect(controller.navigate("browser:one", opened.activeTabId, "http://192.168.1.2/", true)).rejects.toThrow();
    await expect(
      controller.navigate("browser:one", opened.activeTabId, "https://user:pass@example.com/", true),
    ).resolves.toBeDefined();
  });

  test("keeps CDP available per tab before an agent tool is registered", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open(
      "browser:one",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://example.com/",
    );

    await expect(
      controller.automate("browser:one", opened.activeTabId, { method: "DOM.getDocument", params: { depth: 1 } }),
    ).resolves.toEqual({ generation: 1, result: { ok: true } });
  });

  test("captures the active native tab without using CDP", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    await expect(controller.capture("browser:one", opened.activeTabId)).resolves.toBe(
      `data:image/png;base64,${opened.activeTabId}`,
    );
  });

  test("adopts a live popup without reloading it and reveals it after navigation", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host, { maxTabs: 2 });
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    const popupUrl = "https://example.com/popup";
    const adoptPopup = fake.callbacks.get(opened.activeTabId)?.onPopupRequested?.({
      url: popupUrl,
      disposition: "foreground-tab",
      features: "width=640,height=480",
    });
    const popupHandle = adoptPopup?.((tabId, onUrlChanged, callbacks) =>
      fake.host.create(tabId, "persist:test", onUrlChanged, callbacks),
    );

    const beforeNavigation = controller.getState("browser:one");
    const popupTab = beforeNavigation?.tabs.find((tab) => tab.id !== opened.activeTabId);
    expect(fake.callbacks.get(opened.activeTabId)?.constrainVisualZoom).toBe(true);
    expect(fake.callbacks.get(opened.activeTabId)?.disablePageDragRegions).toBe(true);
    expect(fake.callbacks.get(opened.activeTabId)?.disableJavaScriptDialogs).toBe(true);
    expect(fake.callbacks.get(opened.activeTabId)?.keepChromeFocusOnNavigation).toBe(true);
    expect(fake.callbacks.get(opened.activeTabId)?.ignoreBeforeUnload).toBe(true);
    expect(popupHandle).toBeDefined();
    expect(popupTab?.url).toBe(popupUrl);
    expect(fake.callbacks.get(popupTab?.id ?? "")?.constrainVisualZoom).toBe(true);
    expect(fake.callbacks.get(popupTab?.id ?? "")?.disablePageDragRegions).toBe(true);
    expect(fake.callbacks.get(popupTab?.id ?? "")?.disableJavaScriptDialogs).toBe(true);
    expect(fake.callbacks.get(popupTab?.id ?? "")?.keepChromeFocusOnNavigation).toBe(true);
    expect(fake.callbacks.get(popupTab?.id ?? "")?.ignoreBeforeUnload).toBe(true);
    expect(beforeNavigation?.activeTabId).toBe(opened.activeTabId);
    expect(fake.handles.get(popupTab?.id ?? "")?.loads).toBe(0);

    fake.handles.get(popupTab?.id ?? "")?.navigate(popupUrl);

    expect(controller.getState("browser:one")?.activeTabId).toBe(popupTab?.id);
    expect(fake.handles.get(popupTab?.id ?? "")?.invalidations).toBeGreaterThan(0);
    await expect(controller.createTab("browser:one")).rejects.toThrow("tab limit");
  });

  test("closes an unrevealed popup when it starts a native download", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });
    const adoptPopup = fake.callbacks.get(opened.activeTabId)?.onPopupRequested?.({
      url: "https://example.com/report.pdf",
      disposition: "new-window",
      features: "width=640",
    });
    const popupHandle = adoptPopup?.((tabId, onUrlChanged, callbacks) =>
      fake.host.create(tabId, "persist:test", onUrlChanged, callbacks),
    );
    const popupTab = controller.getState("browser:one")?.tabs.find((tab) => tab.id !== opened.activeTabId);

    fake.callbacks.get(popupTab?.id ?? "")?.onDownloadStarted?.();
    await Promise.resolve();

    expect(popupHandle).toBeDefined();
    expect(controller.getState("browser:one")?.tabs.map(({ id }) => id)).toEqual([opened.activeTabId]);
    expect(fake.handles.get(popupTab?.id ?? "")?.closed).toBe(true);
  });

  test("closing the last tab replaces it with a blank tab", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    const next = await controller.closeTab("browser:one", opened.activeTabId);
    expect(next.tabs).toHaveLength(1);
    expect(next.tabs[0].url).toBe("");
    expect(next.activeTabId).not.toBe(opened.activeTabId);
  });

  test("removes an unexpectedly destroyed tab and activates its live sibling", async () => {
    const fake = createFakeHost();
    const stateChanges: string[][] = [];
    const controller = new BrowserPaneController(fake.host, {
      onStateChanged: (snapshot) => stateChanges.push(snapshot.tabs.map(({ id }) => id)),
    });
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });
    const withSecond = await controller.createTab("browser:one", "https://example.test/");
    const destroyedTabId = withSecond.activeTabId;

    fake.callbacks.get(destroyedTabId)?.onDestroyed?.();

    const remaining = controller.getState("browser:one");
    expect(remaining?.tabs.map(({ id }) => id)).toEqual([opened.activeTabId]);
    expect(remaining?.activeTabId).toBe(opened.activeTabId);
    expect(fake.handles.get(opened.activeTabId)?.invalidations).toBeGreaterThan(0);
    expect(stateChanges.at(-1)).toEqual([opened.activeTabId]);

    fake.callbacks.get(destroyedTabId)?.onDestroyed?.();
    expect(controller.getState("browser:one")?.tabs).toHaveLength(1);
  });

  test("removes the context and saved state when its last native tab is destroyed", async () => {
    const fake = createFakeHost();
    const stored = createSessionStore();
    const sessionStore = stored.create();
    const controller = new BrowserPaneController(fake.host, { sessionStore });
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    fake.callbacks.get(opened.activeTabId)?.onDestroyed?.();

    expect(controller.getState("browser:one")).toBeNull();
    expect(sessionStore.get("browser:one")).toBeUndefined();
    expect(fake.surfaceEvents).toContain("dispose:browser:one");

    fake.callbacks.get(opened.activeTabId)?.onDestroyed?.();
    expect(fake.surfaceEvents.filter((event) => event === "dispose:browser:one")).toHaveLength(1);
  });

  test("clears an in-flight transfer when its moved native tab is destroyed", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:source", { x: 0, y: 0, width: 600, height: 400 });
    await controller.createTab("browser:source", "https://example.test/");
    const transfer = controller.beginTabTransfer(
      "browser:source",
      opened.activeTabId,
      "browser:destination",
    );

    fake.callbacks.get(opened.activeTabId)?.onDestroyed?.();

    expect(controller.getState("browser:destination")).toBeNull();
    expect(controller.getState("browser:source")?.tabs).toHaveLength(1);
    expect(() => controller.commitTabTransfer(transfer.transferId)).toThrow("transfer is unavailable");
    await expect(controller.createTab("browser:source")).resolves.toBeDefined();
  });

  test("handles browser tab keyboard shortcuts inside the native page", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    fake.callbacks.get(opened.activeTabId)?.onShortcutRequested?.("newTab");
    await Promise.resolve();
    await Promise.resolve();
    const withSecond = controller.getState("browser:one");
    expect(withSecond?.tabs).toHaveLength(2);

    const secondId = withSecond?.activeTabId;
    expect(secondId).toBeDefined();
    fake.callbacks.get(secondId ?? "")?.onShortcutRequested?.("closeTab");
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getState("browser:one")?.tabs).toHaveLength(1);
  });

  test("routes the element selection shortcut from the native page", async () => {
    const fake = createFakeHost();
    const onSelectionShortcut = mock(() => undefined);
    const controller = new BrowserPaneController(fake.host, { onSelectionShortcut });
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    fake.callbacks.get(opened.activeTabId)?.onShortcutRequested?.("toggleSelection");

    expect(onSelectionShortcut).toHaveBeenCalledWith({
      contextId: "browser:one",
      tabId: opened.activeTabId,
    });
  });

  test("hands page focus back to chrome and returns it to the active native tab", async () => {
    const fake = createFakeHost();
    const onFocusExit = mock(() => undefined);
    const controller = new BrowserPaneController(fake.host, { onFocusExit });
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    fake.callbacks.get(opened.activeTabId)?.onShortcutRequested?.("focusExit");
    expect(onFocusExit).toHaveBeenCalledWith({ contextId: "browser:one", tabId: opened.activeTabId });

    expect(controller.focus("browser:one")).toBe(true);
    expect(fake.handles.get(opened.activeTabId)?.inputs).toEqual([{ kind: "focus" }]);

    controller.layout("browser:one", { x: 0, y: 0, width: 600, height: 400 }, "hidden");
    expect(controller.focus("browser:one")).toBe(false);
  });

  test("sets a responsive viewport only on the requested tab", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    expect(await controller.setViewport("browser:one", opened.activeTabId, {
      width: 375,
      height: 812,
      mobile: true,
    })).toBe(true);
    expect(fake.handles.get(opened.activeTabId)?.viewport).toEqual({ width: 375, height: 812, mobile: true });

    expect(await controller.setViewport("browser:one", opened.activeTabId, null)).toBe(true);
    expect(fake.handles.get(opened.activeTabId)?.viewport).toBeNull();
  });

  test("applies the resolved color scheme only to the active tab", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });
    const second = await controller.createTab("browser:one", "https://example.com/second");

    expect(await controller.setColorScheme("browser:one", "dark")).toBe(true);
    expect(fake.handles.get(second.activeTabId)?.colorScheme).toBe("dark");
    expect(fake.handles.get(opened.activeTabId)?.colorScheme).toBeNull();
  });
});
