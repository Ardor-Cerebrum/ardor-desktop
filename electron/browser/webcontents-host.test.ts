import { beforeEach, describe, expect, mock, test } from "bun:test";

const addChildView = mock(() => undefined);
const removeChildView = mock(() => undefined);
const destroy = mock(() => undefined);
const setBorderRadius = mock(() => undefined);
const addClippedChildView = mock(() => undefined);
const setClipBounds = mock(() => undefined);
const setPageBounds = mock(() => undefined);
const setClipVisible = mock(() => undefined);
const requestFavicon = mock((_options: unknown) => {
  throw new Error("unexpected favicon request");
});
const webContentsListeners = new Map<string, Set<(...args: unknown[]) => void>>();
let currentUrl = "about:blank";

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
    sendCommand: mock(async () => ({})),
  },
  navigationHistory: {
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => undefined),
    goForward: mock(() => undefined),
  },
  session: {
    setPermissionCheckHandler: mock(() => undefined),
    setPermissionRequestHandler: mock(() => undefined),
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
  setWindowOpenHandler: mock(() => undefined),
};

mock.module("electron", () => ({
  app: { getPath: mock(() => "") },
  net: { request: requestFavicon },
  shell: { openExternal: mock(async () => undefined), openPath: mock(async () => "") },
  View: class {
    addChildView = addClippedChildView;
    setBorderRadius = setBorderRadius;
    setBounds = setClipBounds;
    setVisible = setClipVisible;
  },
  WebContentsView: class {
    webContents = webContents;
    setBounds = setPageBounds;
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
    setClipVisible.mockClear();
    requestFavicon.mockReset();
    requestFavicon.mockImplementation(() => {
      throw new Error("unexpected favicon request");
    });
    webContentsListeners.clear();
    currentUrl = "about:blank";
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
});
