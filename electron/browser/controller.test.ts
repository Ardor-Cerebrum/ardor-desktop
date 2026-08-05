import { describe, expect, test } from "bun:test";

import { BrowserController, type BrowserHost, type BrowserTabHandle } from "./controller";
import type { BrowserSiteData } from "../bridge-contract";

function createFakeHost() {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const created: string[] = [];
  const credentialFills: Array<{ username: string; password: string }> = [];
  const siteData: BrowserSiteData[] = [{ domain: "example.com", cookieCount: 2 }];
  const handle: BrowserTabHandle = {
    load: async () => undefined,
    url: () => "https://example.com/",
    title: () => "Example",
    setBounds: () => undefined,
    setVisible: () => undefined,
    close: () => undefined,
    goBack: () => true,
    reload: () => true,
    setZoom: () => undefined,
    input: () => true,
    fillCredential: async (username, password) => {
      credentialFills.push({ username, password });
      return true;
    },
    listSiteData: async () => siteData,
    clearSiteData: async () => true,
    sendCommand: async (method, params) => {
      commands.push({ method, params });
      return { result: { nodeId: 7, text: "example" } };
    },
  };
  const host: BrowserHost = {
    create: (tabId, partition) => {
      created.push(`${tabId}:${partition}`);
      return handle;
    },
  };
  return { host, commands, created, credentialFills, siteData };
}

describe("BrowserController", () => {
  test("creates an isolated persistent profile and grants the initial origin", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);

    const opened = await controller.open({
      url: "https://example.com/start",
      source: "artifact",
      bounds: { x: 1, y: 2, width: 300, height: 200 },
    });

    expect(opened.generation).toBe(1);
    expect(fake.created).toEqual(["tab-1:persist:ardor-browser"]);
    expect(controller.getUrl(opened.generation)).toBe("https://example.com/");
  });

  test("rejects navigation and CDP methods outside the granted origin and allowlist", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);
    const opened = await controller.open({
      url: "https://example.com/start",
      source: "artifact",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    await expect(controller.navigate(opened.generation, "https://evil.example/"))
      .rejects.toThrow("browser origin is not granted");
    await expect(controller.automate(opened.generation, { method: "Browser.grantPermissions", params: {} }))
      .rejects.toThrow("browser automation method is not allowed");
    const response = await controller.automate(opened.generation, {
      method: "DOM.getDocument",
      params: { depth: 1 },
    });

    expect(response).toEqual({ generation: 1, result: { nodeId: 7, text: "example" } });
    expect(fake.commands).toEqual([{ method: "DOM.getDocument", params: { depth: 1 } }]);

    await controller.automate(opened.generation, {
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
    });
    expect(fake.commands.at(-1)).toEqual({
      method: "Runtime.evaluate",
      params: {
        expression: "document.title",
        awaitPromise: true,
        returnByValue: true,
        timeout: 5_000,
        userGesture: false,
      },
    });
  });

  test("rejects malformed sources and browser bounds before creating a view", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);

    await expect(controller.open({
      url: "https://example.com",
      source: "unknown" as "artifact",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    })).rejects.toThrow("browser source is invalid");
    await expect(controller.open({
      url: "https://example.com",
      source: "artifact",
      bounds: { x: 0, y: 0, width: 0, height: 200 },
    })).rejects.toThrow("browser bounds are invalid");
    await expect(controller.open({
      url: "https://example.com",
      source: "artifact",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
      overlays: [{ bounds: { x: 0, y: 0, width: 10, height: 10 }, cornerRadius: 513 }],
    })).rejects.toThrow("browser overlay radius is invalid");
    expect(fake.created).toEqual([]);
  });

  test("rejects private, insecure, and credential-bearing browser URLs", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);

    for (const url of ["http://example.com", "https://localhost", "https://10.0.0.1", "https://user:pass@example.com"]) {
      await expect(controller.open({
        url,
        source: "artifact",
        bounds: { x: 0, y: 0, width: 300, height: 200 },
      })).rejects.toThrow("browser URL");
    }
  });

  test("rejects stale generations after close", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);
    const opened = await controller.open({
      url: "https://example.com/start",
      source: "solution",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    expect(controller.close(opened.generation)).toBe(true);
    expect(controller.close(opened.generation)).toBe(false);
    await expect(controller.automate(opened.generation, { method: "DOM.getDocument" }))
      .rejects.toThrow("browser tab is unavailable");
  });

  test("disposes a tab without changing visibility after its window is closed", async () => {
    let visibilityChanges = 0;
    let closed = false;
    const handle: BrowserTabHandle = {
      load: async () => undefined,
      url: () => "https://example.com/",
      setBounds: () => undefined,
      setVisible: () => {
        visibilityChanges += 1;
      },
      close: () => {
        closed = true;
      },
      sendCommand: async () => ({ result: {} }),
    };
    const controller = new BrowserController({ create: () => handle });

    await controller.open({
      url: "https://example.com/start",
      source: "artifact",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });
    visibilityChanges = 0;

    controller.dispose();

    expect(visibilityChanges).toBe(0);
    expect(closed).toBe(true);
  });

  test("routes safe browser controls and input through the active tab", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);
    const opened = await controller.open({
      url: "https://example.com/start",
      source: "solution",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    expect(controller.control(opened.generation, "back")).toBe(true);
    expect(controller.control(opened.generation, "reload")).toBe(true);
    expect(controller.control(opened.generation, "setZoom", { zoomFactor: 1.25 })).toBe(true);
    expect(controller.input(opened.generation, { kind: "move", x: 2, y: 3 })).toBe(true);
    expect(controller.layout(opened.generation, { x: 0, y: 0, width: 0, height: 0 }, false, [])).toBe(true);
    expect(() => controller.control(opened.generation, "find", { query: "" })).toThrow("find query");
  });

  test("allows the user-confirmed external action only for the current public page", async () => {
    const openedExternal: string[] = [];
    const fake = createFakeHost();
    const original = fake.host.create;
    fake.host.create = (tabId, partition, onUrlChanged) => {
      const handle = original(tabId, partition, onUrlChanged);
      handle.openExternal = async (url) => {
        openedExternal.push(url);
        return true;
      };
      return handle;
    };
    const controller = new BrowserController(fake.host);
    const opened = await controller.open({
      url: "https://example.com/start",
      source: "solution",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    await expect(controller.controlAsync(opened.generation, "openExternal")).resolves.toBe(true);
    expect(openedExternal).toEqual(["https://example.com/"]);
  });

  test("keeps CDP automation scoped to artifact previews", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);
    const opened = await controller.open({
      url: "https://example.com/start",
      source: "solution",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    await expect(controller.automate(opened.generation, { method: "DOM.getDocument" })).rejects.toThrow(
      "artifact previews",
    );
  });

  test("fills credentials only when the stored origin matches the active page", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);
    const opened = await controller.open({
      url: "https://example.com/start",
      source: "artifact",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    await expect(controller.fillCredential(opened.generation, {
      origin: "https://evil.example",
      username: "alice",
      password: "secret",
    })).rejects.toThrow("credential origin is not active");
    await expect(controller.fillCredential(opened.generation, {
      origin: "https://example.com",
      username: "alice",
      password: "secret",
    })).resolves.toBe(true);
    expect(fake.credentialFills).toEqual([{ username: "alice", password: "secret" }]);
  });

  test("lists and clears site data through the active persistent profile", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);

    await controller.open({
      url: "https://example.com/start",
      source: "solution",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    await expect(controller.listSiteData()).resolves.toEqual(fake.siteData);
    await expect(controller.clearSiteData()).resolves.toBe(true);
  });

  test("reports the active tab generation, source, URL, and title", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);

    const opened = await controller.open({
      url: "https://example.com/start",
      source: "artifact",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    expect(controller.getActiveTab()).toEqual({
      generation: opened.generation,
      source: "artifact",
      url: "https://example.com/",
      title: "Example",
    });
    controller.close(opened.generation);
    expect(controller.getActiveTab()).toBeNull();
  });

  test("allows user-initiated navigation to grant a new public origin", async () => {
    let currentUrl = "https://example.com/";
    const commands: string[] = [];
    const handle: BrowserTabHandle = {
      load: async (url) => { currentUrl = url; },
      url: () => currentUrl,
      setBounds: () => undefined,
      setVisible: () => undefined,
      close: () => undefined,
      sendCommand: async (method) => { commands.push(method); return { result: { ok: true } }; },
    };
    const controller = new BrowserController({ create: () => handle });
    const opened = await controller.open({
      url: currentUrl,
      source: "artifact",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    await expect(controller.controlAsync(opened.generation, "navigate", {
      url: "https://other.example/docs",
      userInitiated: true,
    } as unknown as { url: string; userInitiated: boolean })).resolves.toBe(true);
    await expect(controller.automate(opened.generation, { method: "DOM.getDocument" })).resolves.toEqual({
      generation: opened.generation,
      result: { ok: true },
    });
    expect(commands).toEqual(["DOM.getDocument"]);
  });

  test("keeps agent navigation restricted to the granted origin", async () => {
    const fake = createFakeHost();
    const controller = new BrowserController(fake.host);
    const opened = await controller.open({
      url: "https://example.com/start",
      source: "solution",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
    });

    await expect(controller.controlAsync(opened.generation, "navigate", {
      url: "https://other.example/docs",
      userInitiated: false,
    } as unknown as { url: string; userInitiated: boolean })).rejects.toThrow("browser origin is not granted");
  });
});
