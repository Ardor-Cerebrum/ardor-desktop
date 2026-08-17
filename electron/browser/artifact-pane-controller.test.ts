import { describe, expect, test } from "bun:test";

import type { BrowserHost, BrowserHostCallbacks, BrowserTabHandle } from "./controller";
import { ArtifactPaneController } from "./artifact-pane-controller";

function createFakeHost() {
  const handles = new Map<
    string,
    BrowserTabHandle & {
      bounds: unknown;
      closed: boolean;
      cleared: boolean;
      partition: string;
      visible: boolean;
      backgroundThrottling: boolean;
    }
  >();
  const callbacks = new Map<string, BrowserHostCallbacks>();
  const host: BrowserHost = {
    create: (tabId, partition, _onUrlChanged, tabCallbacks = {}) => {
      let currentUrl = "about:blank";
      const handle: BrowserTabHandle & {
        bounds: unknown;
        closed: boolean;
        cleared: boolean;
        partition: string;
        visible: boolean;
        backgroundThrottling: boolean;
      } = {
        bounds: null,
        closed: false,
        cleared: false,
        partition,
        visible: false,
        backgroundThrottling: true,
        load: async (url) => {
          currentUrl = url;
          tabCallbacks.onStateChanged?.();
        },
        url: () => currentUrl,
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
        close: () => {
          handle.closed = true;
          handle.visible = false;
        },
        capturePage: async () => `data:image/png;base64,${tabId}`,
        reload: () => true,
        clearSiteData: async () => {
          handle.cleared = true;
          return true;
        },
        sendCommand: async () => ({ result: { ok: true } }),
      };
      handles.set(tabId, handle);
      callbacks.set(tabId, tabCallbacks);
      return handle;
    },
  };
  return { callbacks, handles, host };
}

describe("ArtifactPaneController", () => {
  test("uses an isolated ephemeral partition per artifact context", async () => {
    const fake = createFakeHost();
    const controller = new ArtifactPaneController(fake.host);
    await controller.open("artifact:one", { x: 10, y: 20, width: 600, height: 400 }, "https://preview.test/a");
    await controller.open("artifact:two", { x: 20, y: 30, width: 500, height: 300 }, "https://preview.test/b");

    const [first, second] = [...fake.handles.values()];
    expect(first.partition).not.toBe(second.partition);
    expect(first.partition.startsWith("persist:")).toBe(false);
    expect(second.partition.startsWith("persist:")).toBe(false);
  });

  test("pins in-page navigation to the preview origin", async () => {
    const fake = createFakeHost();
    const controller = new ArtifactPaneController(fake.host);
    const opened = await controller.open(
      "artifact:one",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://preview.test/path?auth=secret",
    );
    const policy = fake.callbacks.get(`artifact-${opened.generation}`)?.isNavigationAllowed;

    expect(policy?.("https://preview.test/next")).toBe(true);
    expect(policy?.("https://other.test/")).toBe(false);
    expect(policy?.("file:///tmp/secret")).toBe(false);
    const permissionPolicy = fake.callbacks.get(`artifact-${opened.generation}`)?.isPermissionAllowed;
    expect(permissionPolicy?.("clipboard-sanitized-write", "https://preview.test/next")).toBe(true);
    expect(permissionPolicy?.("clipboard-sanitized-write", "https://other.test/")).toBe(false);
    expect(permissionPolicy?.("media", "https://preview.test/")).toBe(false);
  });

  test("keeps CDP available while separating it from the browser pane", async () => {
    const fake = createFakeHost();
    const controller = new ArtifactPaneController(fake.host);
    await controller.open(
      "artifact:one",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://preview.test/",
    );

    await expect(controller.automate("artifact:one", { method: "DOM.getDocument", params: { depth: 1 } })).resolves.toEqual({
      generation: 1,
      result: { ok: true },
    });
  });

  test("captures the native artifact surface without using CDP", async () => {
    const fake = createFakeHost();
    const controller = new ArtifactPaneController(fake.host);
    await controller.open("artifact:one", { x: 0, y: 0, width: 600, height: 400 }, "https://preview.test/a");

    await expect(controller.capture("artifact:one")).resolves.toMatch(/^data:image\/png;base64,artifact-/);
  });

  test("clears preview storage before closing its native surface", async () => {
    const fake = createFakeHost();
    const controller = new ArtifactPaneController(fake.host);
    const opened = await controller.open(
      "artifact:one",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://preview.test/",
    );
    const handle = fake.handles.get(`artifact-${opened.generation}`);

    await expect(controller.close("artifact:one")).resolves.toBe(true);
    expect(handle?.cleared).toBe(true);
    expect(handle?.closed).toBe(true);
    expect(handle?.backgroundThrottling).toBe(true);
  });

  test("maps artifact presentation to native visibility and renderer throttling", async () => {
    const fake = createFakeHost();
    const controller = new ArtifactPaneController(fake.host);
    const opened = await controller.open(
      "artifact:one",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://preview.test/",
    );
    const handle = fake.handles.get(`artifact-${opened.generation}`);

    controller.layout("artifact:one", { x: 0, y: 0, width: 600, height: 400 }, "occluded");
    expect(handle).toMatchObject({ visible: false, backgroundThrottling: false });

    controller.layout("artifact:one", { x: 0, y: 0, width: 600, height: 400 }, "hidden");
    expect(handle).toMatchObject({ visible: false, backgroundThrottling: true });

    controller.layout("artifact:one", { x: 0, y: 0, width: 600, height: 400 }, "visible");
    expect(handle).toMatchObject({ visible: true, backgroundThrottling: true });
  });

  test("reopening a stable context preserves live WebContents state", async () => {
    const fake = createFakeHost();
    const controller = new ArtifactPaneController(fake.host);
    const opened = await controller.open(
      "artifact:one",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://preview.test/start",
    );
    const handle = fake.handles.get(`artifact-${opened.generation}`);
    await handle?.load("https://preview.test/changed#form-state");

    await controller.open(
      "artifact:one",
      { x: 10, y: 20, width: 500, height: 300 },
      "https://preview.test/start",
      "hidden",
    );

    expect(handle?.url()).toBe("https://preview.test/changed#form-state");
    expect(handle).toMatchObject({ visible: false, backgroundThrottling: true });
  });

  test("restores artifact throttling when disposing an occluded preview", async () => {
    const fake = createFakeHost();
    const controller = new ArtifactPaneController(fake.host);
    const opened = await controller.open(
      "artifact:one",
      { x: 0, y: 0, width: 600, height: 400 },
      "https://preview.test/",
    );
    const handle = fake.handles.get(`artifact-${opened.generation}`);

    controller.layout("artifact:one", { x: 0, y: 0, width: 600, height: 400 }, "occluded");
    controller.dispose();

    expect(handle).toMatchObject({ closed: true, visible: false, backgroundThrottling: true });
  });
});
