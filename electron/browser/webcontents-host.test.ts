import { beforeEach, describe, expect, mock, test } from "bun:test";

const addChildView = mock(() => undefined);
const removeChildView = mock(() => {
  throw new TypeError("Object has been destroyed");
});
const destroy = mock(() => undefined);
const setBorderRadius = mock(() => undefined);
const addClippedChildView = mock(() => undefined);
const setClipBounds = mock(() => undefined);
const setPageBounds = mock(() => undefined);
const setClipVisible = mock(() => undefined);

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
  getURL: mock(() => "about:blank"),
  isDestroyed: mock(() => false),
  isLoading: mock(() => false),
  loadURL: mock(async () => undefined),
  on: mock(() => undefined),
  removeListener: mock(() => undefined),
  setBackgroundThrottling: mock(() => undefined),
  setWindowOpenHandler: mock(() => undefined),
};

mock.module("electron", () => ({
  app: { getPath: mock(() => "") },
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
});
