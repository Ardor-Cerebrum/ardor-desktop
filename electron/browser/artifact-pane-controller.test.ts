import { describe, expect, test } from "bun:test";

import type { BrowserHost, BrowserHostCallbacks, BrowserTabHandle } from "./controller";
import { ArtifactPaneController } from "./artifact-pane-controller";

function createFakeHost() {
  const handles = new Map<
    string,
    BrowserTabHandle & { bounds: unknown; closed: boolean; cleared: boolean; partition: string; visible: boolean }
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
      } = {
        bounds: null,
        closed: false,
        cleared: false,
        partition,
        visible: false,
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
        close: () => {
          handle.closed = true;
          handle.visible = false;
        },
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
  });
});
