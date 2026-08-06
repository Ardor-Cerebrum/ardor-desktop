import { describe, expect, test } from "bun:test";

import type { BrowserHost, BrowserHostCallbacks, BrowserTabHandle } from "./controller";
import { BrowserPaneController } from "./pane-controller";

function createFakeHost() {
  const handles = new Map<string, BrowserTabHandle & { visible: boolean; bounds: unknown }>();
  const callbacks = new Map<string, BrowserHostCallbacks>();
  const host: BrowserHost = {
    create: (tabId, _partition, _onUrlChanged, tabCallbacks = {}) => {
      let currentUrl = "about:blank";
      const handle: BrowserTabHandle & { visible: boolean; bounds: unknown } = {
        visible: false,
        bounds: null,
        load: async (url) => {
          currentUrl = url;
          tabCallbacks.onStateChanged?.();
        },
        url: () => currentUrl,
        title: () => (currentUrl === "about:blank" ? "" : new URL(currentUrl).hostname),
        canGoBack: () => currentUrl !== "about:blank",
        canGoForward: () => false,
        isLoading: () => false,
        setBounds: (bounds) => {
          handle.bounds = bounds;
        },
        setVisible: (visible) => {
          handle.visible = visible;
        },
        close: () => {
          handle.visible = false;
        },
        capturePage: async () => `data:image/png;base64,${tabId}`,
        goBack: () => true,
        goForward: () => false,
        reload: () => true,
        sendCommand: async () => ({ result: { ok: true } }),
      };
      handles.set(tabId, handle);
      callbacks.set(tabId, tabCallbacks);
      return handle;
    },
  };
  return { callbacks, handles, host };
}

describe("BrowserPaneController", () => {
  test("keeps independent WebContents handles for tabs and switches native visibility", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 10, y: 20, width: 600, height: 400 });
    const firstId = opened.activeTabId;

    const withSecond = await controller.createTab("browser:one", "https://example.com/");
    const secondId = withSecond.activeTabId;

    expect(secondId).not.toBe(firstId);
    expect(fake.handles.get(firstId)?.visible).toBe(false);
    expect(fake.handles.get(secondId)?.visible).toBe(true);

    const selected = controller.selectTab("browser:one", firstId);
    expect(selected.activeTabId).toBe(firstId);
    expect(fake.handles.get(firstId)?.visible).toBe(true);
    expect(fake.handles.get(secondId)?.visible).toBe(false);
  });

  test("supports public HTTPS and loopback HTTP while rejecting private network and credential URLs", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host);
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    await expect(controller.navigate("browser:one", opened.activeTabId, "http://localhost:3000/", true)).resolves.toBeDefined();
    await expect(controller.navigate("browser:one", opened.activeTabId, "https://example.com/", true)).resolves.toBeDefined();
    await expect(controller.navigate("browser:one", opened.activeTabId, "http://192.168.1.2/", true)).rejects.toThrow();
    await expect(controller.navigate("browser:one", opened.activeTabId, "https://user:pass@example.com/", true)).rejects.toThrow();
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

  test("adopts safe popup requests as new tabs and caps the tab count", async () => {
    const fake = createFakeHost();
    const controller = new BrowserPaneController(fake.host, { maxTabs: 2 });
    const opened = await controller.open("browser:one", { x: 0, y: 0, width: 600, height: 400 });

    fake.callbacks.get(opened.activeTabId)?.onOpenRequested?.("https://example.com/popup");
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getState("browser:one")?.tabs).toHaveLength(2);
    await expect(controller.createTab("browser:one")).rejects.toThrow("tab limit");
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
});
