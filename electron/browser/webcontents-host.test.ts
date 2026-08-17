import { beforeEach, describe, expect, mock, test } from "bun:test";

const addChildView = mock(() => undefined);
const removeChildView = mock(() => {
  throw new TypeError("Object has been destroyed");
});
const destroy = mock(() => undefined);

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
  WebContentsView: class {
    webContents = webContents;
    setBounds = mock(() => undefined);
    setVisible = mock(() => undefined);
  },
}));

const { createWebContentsBrowserHost } = await import("./webcontents-host");

describe("WebContents browser host", () => {
  beforeEach(() => {
    addChildView.mockClear();
    removeChildView.mockClear();
    destroy.mockClear();
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
