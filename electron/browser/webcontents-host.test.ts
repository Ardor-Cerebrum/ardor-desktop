import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { BrowserHostCallbacks } from "./controller";

const addChildView = mock(() => undefined);
const removeChildView = mock(() => undefined);
const destroy = mock(() => undefined);
const setBorderRadius = mock(() => undefined);
const addClippedChildView = mock(() => undefined);
const setClipBounds = mock(() => undefined);
const setPageBounds = mock(() => undefined);
const setPageBackgroundColor = mock(() => undefined);
const setPageVisible = mock(() => undefined);
const setClipVisible = mock(() => undefined);
const removeClippedChildView = mock(() => undefined);
const themeListeners = new Set<() => void>();
const createdContainers: unknown[] = [];
const createdPageViews: unknown[] = [];
let darkTheme = false;
const requestFavicon = mock((_options: unknown) => {
  throw new Error("unexpected favicon request");
});
const sendDebuggerCommand = mock(async (_method: string, _params?: Record<string, unknown>) => ({}));
const webContentsListeners = new Map<string, Set<(...args: unknown[]) => void>>();
let currentUrl = "about:blank";
type WindowOpenDetails = {
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  features: string;
};
type WindowOpenResponse = {
  action: "allow" | "deny";
  createWindow?: (options: { webPreferences?: Record<string, unknown> }) => unknown;
  overrideBrowserWindowOptions?: unknown;
};
let windowOpenHandler: ((details: WindowOpenDetails) => WindowOpenResponse) | undefined;

function requestWindowOpen(
  url: string,
  disposition: WindowOpenDetails["disposition"] = "foreground-tab",
  features = "",
): WindowOpenResponse | undefined {
  return windowOpenHandler?.({ url, disposition, features });
}

function emitWebContents(event: string, ...args: unknown[]): void {
  for (const listener of webContentsListeners.get(event) ?? []) listener(...args);
}

function png(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function configureFaviconResponse(bytes: Buffer, deferred = false) {
  const abort = mock(() => undefined);
  let respond: (() => void) | undefined;
  requestFavicon.mockImplementation(() => {
    const requestListeners = new Map<string, (...args: unknown[]) => void>();
    return {
      abort,
      end: () => {
        const deliver = () => {
          const responseListeners = new Map<string, (...args: unknown[]) => void>();
          requestListeners.get("response")?.({
            statusCode: 200,
            headers: { "content-type": "image/png", "content-length": String(bytes.length) },
            on: (event: string, listener: (...args: unknown[]) => void) => {
              responseListeners.set(event, listener);
            },
          });
          responseListeners.get("data")?.(bytes);
          responseListeners.get("end")?.();
        };
        if (deferred) respond = deliver;
        else queueMicrotask(deliver);
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        requestListeners.set(event, listener);
      },
    };
  });
  return { abort, respond: () => respond?.() };
}

async function flushTasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const webContents = {
  debugger: {
    attach: mock(() => undefined),
    isAttached: mock(() => true),
    sendCommand: sendDebuggerCommand,
  },
  navigationHistory: {
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => undefined),
    goForward: mock(() => undefined),
  },
  session: {
    on: mock(() => undefined),
    setPermissionCheckHandler: mock(() => undefined),
    setPermissionRequestHandler: mock(() => undefined),
    webRequest: { onHeadersReceived: mock(() => undefined) },
  },
  destroy,
  getTitle: mock(() => ""),
  getURL: mock(() => currentUrl),
  isDestroyed: mock(() => false),
  isLoading: mock(() => false),
  loadURL: mock(async () => undefined),
  on: mock((event: string, listener: (...args: unknown[]) => void) => {
    const listeners = webContentsListeners.get(event) ?? new Set();
    listeners.add(listener);
    webContentsListeners.set(event, listeners);
  }),
  removeListener: mock((event: string, listener: (...args: unknown[]) => void) => {
    webContentsListeners.get(event)?.delete(listener);
  }),
  setBackgroundThrottling: mock(() => undefined),
  setWindowOpenHandler: mock((handler: (details: WindowOpenDetails) => WindowOpenResponse) => {
    windowOpenHandler = handler;
  }),
};

mock.module("electron", () => ({
  app: { getPath: mock(() => "") },
  nativeTheme: {
    get shouldUseDarkColors() {
      return darkTheme;
    },
    on: mock((_event: "updated", listener: () => void) => themeListeners.add(listener)),
    removeListener: mock((_event: "updated", listener: () => void) => themeListeners.delete(listener)),
  },
  net: { request: requestFavicon },
  shell: { openExternal: mock(async () => undefined), openPath: mock(async () => "") },
  View: class {
    constructor() {
      createdContainers.push(this);
    }
    addChildView = addClippedChildView;
    removeChildView = removeClippedChildView;
    setBorderRadius = setBorderRadius;
    setBounds = setClipBounds;
    setVisible = setClipVisible;
  },
  WebContentsView: class {
    constructor() {
      createdPageViews.push(this);
    }
    webContents = webContents;
    setBackgroundColor = setPageBackgroundColor;
    setBounds = setPageBounds;
    setVisible = setPageVisible;
  },
}));

const { createWebContentsBrowserHost } = await import("./webcontents-host");

describe("WebContents browser host", () => {
  beforeEach(() => {
    addChildView.mockClear();
    removeChildView.mockClear();
    destroy.mockClear();
    setBorderRadius.mockClear();
    addClippedChildView.mockClear();
    setClipBounds.mockClear();
    setPageBounds.mockClear();
    setPageBackgroundColor.mockClear();
    setPageVisible.mockClear();
    setClipVisible.mockClear();
    removeClippedChildView.mockClear();
    themeListeners.clear();
    createdContainers.length = 0;
    createdPageViews.length = 0;
    darkTheme = false;
    requestFavicon.mockReset();
    requestFavicon.mockImplementation(() => {
      throw new Error("unexpected favicon request");
    });
    webContentsListeners.clear();
    windowOpenHandler = undefined;
    currentUrl = "about:blank";
    webContents.getURL.mockImplementation(() => currentUrl);
    webContents.isDestroyed.mockImplementation(() => false);
    webContents.loadURL.mockReset();
    webContents.loadURL.mockImplementation(async () => undefined);
    sendDebuggerCommand.mockReset();
    sendDebuggerCommand.mockImplementation(async () => ({}));
  });

  test("clips only the bottom edge of native surfaces to the app tile radius", () => {
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);

    const handle = host.create("tab-1", "persist:test");
    handle.setBounds({ x: 20, y: 30, width: 200, height: 100 });

    expect(setBorderRadius).toHaveBeenCalledWith(16);
    expect(setClipBounds).toHaveBeenCalledWith({ x: 20, y: 14, width: 200, height: 116 });
    expect(setPageBounds).toHaveBeenCalledWith({ x: 0, y: 16, width: 200, height: 100 });
  });

  test("raises an existing native surface by re-adding it as the topmost child", () => {
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);
    const handle = host.create("tab-1", "persist:test");
    const mountedView = addChildView.mock.calls[0]?.[0];

    handle.raise?.();

    expect(addChildView).toHaveBeenCalledTimes(2);
    expect(addChildView.mock.calls[1]?.[0]).toBe(mountedView);
  });

  test("mounts pane tabs through one context container and lays each tab out once", () => {
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);
    const surface = host.createPaneSurface("browser:context");
    const first = surface.create("tab-1", "persist:test");
    const second = surface.create("tab-2", "persist:test");

    expect(addChildView).not.toHaveBeenCalled();
    expect(addClippedChildView).not.toHaveBeenCalled();

    surface.attach();
    expect(addChildView).toHaveBeenCalledOnce();
    expect(addChildView).toHaveBeenCalledWith(createdContainers[0]);
    expect(addClippedChildView.mock.calls.map(([view]) => view)).toEqual(createdPageViews);
    surface.attach();
    expect(addChildView).toHaveBeenCalledOnce();

    setPageBounds.mockClear();
    surface.setBounds({ x: 20, y: 5, width: 200, height: 100 });
    expect(setBorderRadius).toHaveBeenCalledWith(16);
    expect(setClipBounds).toHaveBeenLastCalledWith({ x: 20, y: 0, width: 200, height: 105 });
    expect(setPageBounds).toHaveBeenCalledTimes(2);
    expect(setPageBounds.mock.calls).toEqual([
      [{ x: 0, y: 5, width: 200, height: 100 }],
      [{ x: 0, y: 5, width: 200, height: 100 }],
    ]);

    surface.raise(first);
    expect(addClippedChildView).toHaveBeenLastCalledWith(createdPageViews[0]);
    surface.detach();
    expect(removeClippedChildView.mock.calls.map(([view]) => view)).toEqual(createdPageViews);
    expect(removeChildView).toHaveBeenCalledWith(createdContainers[0]);

    first.close();
    second.close();
    surface.dispose();
  });

  test("reparents a live pane tab without destroying its WebContents", () => {
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);
    const source = host.createPaneSurface("browser:source");
    const destination = host.createPaneSurface("browser:destination");
    const handle = source.create("tab-1", "persist:test");
    source.attach();
    addClippedChildView.mockClear();
    removeClippedChildView.mockClear();

    source.remove(handle);
    destination.add(handle);
    expect(removeClippedChildView).toHaveBeenCalledWith(createdPageViews[0]);
    expect(addClippedChildView).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();

    destination.attach();
    expect(addClippedChildView).toHaveBeenCalledWith(createdPageViews[0]);
    handle.close();
    source.dispose();
    destination.dispose();
  });

  test("keeps a live pane tab recoverable when native reparenting throws", () => {
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);
    const source = host.createPaneSurface("browser:source");
    const destination = host.createPaneSurface("browser:destination");
    const handle = source.create("tab-1", "persist:test");
    source.attach();

    removeClippedChildView.mockImplementationOnce(() => {
      throw new Error("native remove failure");
    });
    expect(() => source.remove(handle)).toThrow("native remove failure");
    expect(() => source.raise(handle)).not.toThrow();

    source.remove(handle);
    setPageBackgroundColor.mockImplementationOnce(() => {
      throw new Error("native add failure");
    });
    expect(() => destination.add(handle)).toThrow("native add failure");
    expect(() => source.add(handle)).not.toThrow();
    expect(() => source.raise(handle)).not.toThrow();
    expect(destroy).not.toHaveBeenCalled();

    handle.close();
    source.dispose();
    destination.dispose();
  });

  test("uses one pane theme listener and keeps legacy surfaces unchanged", () => {
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);

    const legacy = host.create("legacy-tab", "persist:test");
    expect(setPageBackgroundColor).not.toHaveBeenCalled();
    expect(themeListeners.size).toBe(0);
    legacy.close();

    const surface = host.createPaneSurface("browser:context");
    const first = surface.create("tab-1", "persist:test");
    const second = surface.create("tab-2", "persist:test");
    expect(themeListeners.size).toBe(1);
    expect(setPageBackgroundColor).toHaveBeenLastCalledWith("#f5f5f5");

    currentUrl = "https://example.test/page";
    emitWebContents("did-navigate");
    expect(setPageBackgroundColor).toHaveBeenLastCalledWith("#ffffff");

    darkTheme = true;
    for (const listener of themeListeners) listener();
    expect(setPageBackgroundColor).toHaveBeenLastCalledWith("#ffffff");

    currentUrl = "http://127.0.0.1/page";
    emitWebContents("did-navigate");
    expect(setPageBackgroundColor).toHaveBeenLastCalledWith("#131312");

    first.close();
    second.close();
    surface.dispose();
    expect(themeListeners.size).toBe(0);
  });

  test("removes an externally destroyed pane child without reading its URL", () => {
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);
    const surface = host.createPaneSurface("browser:context");
    const handle = surface.create("tab-1", "persist:test");
    surface.attach();
    webContents.isDestroyed.mockImplementation(() => true);
    webContents.getURL.mockImplementation(() => {
      throw new Error("destroyed WebContents URL");
    });

    expect(() => {
      for (const listener of themeListeners) listener();
    }).not.toThrow();
    expect(() => handle.close()).not.toThrow();
    expect(removeClippedChildView).toHaveBeenCalledWith(createdPageViews[0]);
    expect(destroy).not.toHaveBeenCalled();
    surface.dispose();
  });

  test("does not touch a destroyed BrowserWindow while disposing a live child WebContents", () => {
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => true,
    } as never);
    const handle = host.create("tab-1", "persist:test");

    expect(() => handle.close()).not.toThrow();
    expect(removeChildView).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  test("retains a data favicon while loading and clears it only after committed navigation", () => {
    const onStateChanged = mock(() => undefined);
    const handle = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onStateChanged });
    const icon = `data:image/png;base64,${png().toString("base64")}`;

    currentUrl = "https://example.test/page";
    emitWebContents("page-favicon-updated", {}, [icon]);
    expect(handle.faviconUrl?.()).toBe(icon);

    emitWebContents("did-start-loading");
    emitWebContents("did-navigate-in-page");
    expect(handle.faviconUrl?.()).toBe(icon);

    emitWebContents("did-navigate");
    expect(handle.faviconUrl?.()).toBeUndefined();
    expect(onStateChanged).toHaveBeenCalledTimes(4);
  });

  test("reports blocked credential navigation without emitting plaintext through tab state", () => {
    const onNavigationBlocked = mock(() => undefined);
    const onStateChanged = mock(() => undefined);
    createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onNavigationBlocked, onStateChanged });
    const preventDefault = mock(() => undefined);

    emitWebContents(
      "will-redirect",
      { preventDefault },
      "https://username:password@example.test/private",
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onNavigationBlocked).toHaveBeenCalledWith(
      "example.test",
      "credentials",
    );
    expect(onStateChanged).not.toHaveBeenCalled();
  });

  test("reports navigation blocked by the public or localhost policy", () => {
    const onNavigationBlocked = mock(() => undefined);
    createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onNavigationBlocked });

    emitWebContents(
      "will-navigate",
      { preventDefault: mock(() => undefined) },
      "http://192.168.1.10/private",
    );

    expect(onNavigationBlocked).toHaveBeenCalledWith("192.168.1.10", "policy");
  });

  test("reports an unsafe popup instead of silently dropping it", () => {
    const onNavigationBlocked = mock(() => undefined);
    const onPopupRequested = mock(() => null);
    createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onNavigationBlocked, onPopupRequested });

    expect(requestWindowOpen("https://user:secret@example.test/private")).toEqual({ action: "deny" });
    expect(onNavigationBlocked).toHaveBeenCalledWith("example.test", "credentials");
    expect(onPopupRequested).not.toHaveBeenCalled();
  });

  test("keeps external protocols outside the embedded browser", () => {
    const onNavigationBlocked = mock(() => undefined);
    const onPopupRequested = mock(() => null);
    createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onNavigationBlocked, onPopupRequested });

    expect(requestWindowOpen("mailto:hello@example.test")).toEqual({ action: "deny" });
    expect(onNavigationBlocked).toHaveBeenCalledWith("mailto:", "policy");
    expect(onPopupRequested).not.toHaveBeenCalled();
  });

  test("adopts a live popup WebContentsView instead of reloading its URL", () => {
    let popupHandle: ReturnType<ReturnType<NonNullable<BrowserHostCallbacks["onPopupRequested"]>>>;
    const onPopupRequested: NonNullable<BrowserHostCallbacks["onPopupRequested"]> = mock(
      (request) => (createTab) => {
        expect(request).toEqual({
          url: "https://example.test/oauth/callback",
          disposition: "new-window",
          features: "",
        });
        popupHandle = createTab("tab-2");
        return popupHandle;
      },
    );
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);
    const opener = host.create("tab-1", "persist:test", undefined, { onPopupRequested });

    emitWebContents("input-event", {}, { type: "mouseDown" });
    const response = requestWindowOpen("https://example.test/oauth/callback", "new-window");
    expect(response?.action).toBe("allow");
    const adoptedWebContents = response?.createWindow?.({ webPreferences: {} });

    expect(adoptedWebContents).toBe(webContents);
    expect(createdPageViews).toHaveLength(2);
    expect(webContents.loadURL).not.toHaveBeenCalled();

    popupHandle?.close();
    opener.close();
  });

  test("keeps unshaped opens in the current tab and denies stale popups", () => {
    const onPopupRequested = mock(() => () => null);
    const handle = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onPopupRequested });

    expect(requestWindowOpen("https://example.test/current")).toEqual({ action: "deny" });
    expect(webContents.loadURL).toHaveBeenCalledWith("https://example.test/current");
    expect(requestWindowOpen("https://example.test/popup", "new-window")).toEqual({ action: "deny" });
    expect(onPopupRequested).not.toHaveBeenCalled();

    handle.close();
  });

  test("retries only failed main-frame loads and ignores aborted navigation", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    const schedule = mock((callback: () => void, _delayMs?: number) => {
      scheduled.push(callback);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    });
    globalThis.setTimeout = schedule as typeof setTimeout;

    try {
      const handle = createWebContentsBrowserHost({
        contentView: { addChildView, removeChildView },
        isDestroyed: () => false,
      } as never).create("tab-1", "persist:test");
      await handle.load("https://example.test/page");
      webContents.loadURL.mockClear();

      emitWebContents("did-fail-load", {}, -3, "ERR_ABORTED", "https://example.test/page", true);
      emitWebContents("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://example.test/frame", false);
      expect(schedule).not.toHaveBeenCalled();

      emitWebContents("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://example.test/page", true);
      expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1_000);
      scheduled[0]?.();
      await Promise.resolve();
      expect(webContents.loadURL).toHaveBeenCalledWith("https://example.test/page");
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("fetches a remote favicon through the tab session and exposes only validated data", async () => {
    const icon = png();
    configureFaviconResponse(icon);
    const handle = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test");

    currentUrl = "http://127.0.0.1/page";
    emitWebContents("page-favicon-updated", {}, ["http://127.0.0.1/icon.png"]);
    await flushTasks();

    expect(requestFavicon).toHaveBeenCalledWith({
      method: "GET",
      redirect: "manual",
      session: webContents.session,
      url: "http://127.0.0.1/icon.png",
    });
    expect(handle.faviconUrl?.()).toBe(`data:image/png;base64,${icon.toString("base64")}`);
  });

  test("aborts and ignores a remote favicon from the previous committed document", async () => {
    const pending = configureFaviconResponse(png(), true);
    const onStateChanged = mock(() => undefined);
    const handle = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onStateChanged });

    currentUrl = "http://127.0.0.1/old";
    emitWebContents("page-favicon-updated", {}, ["http://127.0.0.1/old-icon.png"]);
    await flushTasks();
    currentUrl = "http://127.0.0.1/new";
    emitWebContents("did-navigate");
    pending.respond();
    await flushTasks();

    expect(pending.abort).toHaveBeenCalledOnce();
    expect(handle.faviconUrl?.()).toBeUndefined();
    expect(onStateChanged).toHaveBeenCalledOnce();
  });

  test("probes the origin favicon after loading stops without a candidate", async () => {
    const icon = png();
    configureFaviconResponse(icon);
    const handle = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test");

    currentUrl = "http://127.0.0.1/page";
    emitWebContents("did-stop-loading");
    await flushTasks();

    expect(requestFavicon).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1/favicon.ico" }),
    );
    expect(handle.faviconUrl?.()).toBe(`data:image/png;base64,${icon.toString("base64")}`);
  });

  test("does not probe a fallback while an icon or favicon request already exists", async () => {
    const icon = png();
    const pending = configureFaviconResponse(icon, true);
    const host = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never);
    const handle = host.create("tab-1", "persist:test");
    currentUrl = "http://127.0.0.1/page";

    emitWebContents("page-favicon-updated", {}, ["http://127.0.0.1/icon.png"]);
    await flushTasks();
    emitWebContents("did-stop-loading");
    expect(requestFavicon).toHaveBeenCalledTimes(1);

    pending.respond();
    await flushTasks();
    emitWebContents("did-stop-loading");
    expect(requestFavicon).toHaveBeenCalledTimes(1);
    expect(handle.faviconUrl?.()).toBe(`data:image/png;base64,${icon.toString("base64")}`);
  });

  test("aborts a favicon request and ignores its late result after close", async () => {
    const pending = configureFaviconResponse(png(), true);
    const onStateChanged = mock(() => undefined);
    const handle = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onStateChanged });

    currentUrl = "http://127.0.0.1/page";
    emitWebContents("page-favicon-updated", {}, ["http://127.0.0.1/icon.png"]);
    await flushTasks();
    handle.close();
    pending.respond();
    await flushTasks();

    expect(pending.abort).toHaveBeenCalledOnce();
    expect(handle.faviconUrl?.()).toBeUndefined();
    expect(onStateChanged).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  test("forwards only the platform primary-modifier tab shortcuts", () => {
    const onShortcutRequested = mock(() => undefined);
    createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onShortcutRequested });
    const preventDefault = mock(() => undefined);
    const primaryModifier = process.platform === "darwin" ? { meta: true } : { control: true };
    const otherPlatformModifier = process.platform === "darwin" ? { control: true } : { meta: true };
    const baseInput = {
      alt: false,
      control: false,
      isAutoRepeat: false,
      key: "t",
      meta: false,
      shift: false,
      type: "keyDown",
    };

    emitWebContents("before-input-event", { preventDefault }, { ...baseInput, ...primaryModifier });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onShortcutRequested).toHaveBeenCalledWith("newTab");

    preventDefault.mockClear();
    onShortcutRequested.mockClear();
    emitWebContents("before-input-event", { preventDefault }, { ...baseInput, ...otherPlatformModifier });
    emitWebContents(
      "before-input-event",
      { preventDefault },
      { ...baseInput, ...primaryModifier, shift: true },
    );
    emitWebContents(
      "before-input-event",
      { preventDefault },
      { ...baseInput, ...primaryModifier, alt: true },
    );
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onShortcutRequested).not.toHaveBeenCalled();
  });

  test("claims repeat and synthetic tab shortcuts without forwarding them", async () => {
    const onShortcutRequested = mock(() => undefined);
    const handle = createWebContentsBrowserHost({
      contentView: { addChildView, removeChildView },
      isDestroyed: () => false,
    } as never).create("tab-1", "persist:test", undefined, { onShortcutRequested });
    const preventDefault = mock(() => undefined);
    const primaryModifier = process.platform === "darwin" ? { meta: true } : { control: true };
    const input = {
      alt: false,
      control: false,
      isAutoRepeat: true,
      key: "w",
      meta: false,
      shift: false,
      type: "keyDown",
      ...primaryModifier,
    };

    emitWebContents("before-input-event", { preventDefault }, input);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onShortcutRequested).not.toHaveBeenCalled();

    preventDefault.mockClear();
    sendDebuggerCommand.mockImplementation(async (method) => {
      if (method.startsWith("Input.")) {
        emitWebContents("before-input-event", { preventDefault }, { ...input, isAutoRepeat: false });
      }
      return {};
    });
    await handle.sendCommand("Input.dispatchKeyEvent", {});
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onShortcutRequested).not.toHaveBeenCalled();
  });
});
