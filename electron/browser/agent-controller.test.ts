import { describe, expect, mock, test } from "bun:test";

import type { BrowserPaneSnapshot } from "../bridge-contract";
import type { BrowserTabHandle } from "./browser-surface";
import { BrowserAgentController } from "./agent-controller";
import type { BrowserAgentTabTarget, BrowserPaneController } from "./pane-controller";

function createFixture() {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let snapshot: BrowserPaneSnapshot = {
    activeTabId: "tab-1",
    contextId: "context-1",
    tabs: [
      {
        active: true,
        canGoBack: false,
        canGoForward: false,
        generation: 1,
        id: "tab-1",
        loading: false,
        title: "Example",
        url: "https://example.com/page",
      },
    ],
  };
  let target: BrowserAgentTabTarget;
  const handle = {
    agentDiagnostics: () => ({
      consoleMessages: () => [
        { level: "error" as const, origin: "https://example.com", text: "boom", timestamp: 1 },
      ],
      networkRequests: () => [
        { method: "GET", requestId: "request-1", status: 200, timestamp: 1, url: "https://example.com/api" },
      ],
      responseBody: async () => ({ base64Encoded: false, body: "ok" }),
    }),
    goBack: mock(() => true),
    goForward: mock(() => true),
    sendCommand: mock(async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Page.getLayoutMetrics") {
        return { cssVisualViewport: { clientHeight: 600, clientWidth: 1200, pageX: 0, pageY: 0 } };
      }
      if (method === "Page.captureScreenshot") return { data: "jpeg-data" };
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression);
        if (expression.includes("searchEntries.filter")) {
          return { result: { value: { content: "- button [ref_1]", matchCount: 1, truncated: false } } };
        }
        if (expression.includes("candidates.find")) {
          return { result: { value: { content: "Article", fullLength: 7, truncated: false } } };
        }
        if (expression.includes("dispatchEvent(new InputEvent")) return { result: { value: { ok: true } } };
        if (expression.includes("state.elements = nextElements")) {
          return {
            result: {
              value: {
                content: "- document\n  - button [ref_1]",
                fullLength: 35,
                truncated: false,
                viewport: { height: 600, width: 1200 },
              },
            },
          };
        }
        if (expression.includes("element.focus()")) return { result: { value: { ok: true } } };
        if (expression.includes("return { x: rect.left")) return { result: { value: { x: 10, y: 20 } } };
        if (params?.contextId === undefined) return { result: { value: { inspected: true } } };
        return { result: { value: { ok: true } } };
      }
      return {};
    }),
    setColorScheme: mock(async () => true),
  } as unknown as BrowserTabHandle;
  target = { generation: 1, handle, id: "tab-1", navigationEpoch: 3, url: "https://example.com/page" };

  const panes = {
    closeTab: mock(async (_contextId: string, tabId: string) => {
      snapshot = { ...snapshot, activeTabId: "tab-1", tabs: snapshot.tabs.filter((tab) => tab.id !== tabId) };
      return snapshot;
    }),
    createTab: mock(async () => {
      const tabId = `tab-${snapshot.tabs.length + 1}`;
      snapshot = {
        ...snapshot,
        activeTabId: tabId,
        tabs: [
          ...snapshot.tabs.map((tab) => ({ ...tab, active: false })),
          { ...snapshot.tabs[0], active: true, id: tabId, title: "New tab", url: "about:blank" },
        ],
      };
      return snapshot;
    }),
    getState: mock(() => snapshot),
    navigateAgentTab: mock(async (_contextId: string, tabId: string, url: string) => {
      target = { ...target, id: tabId, navigationEpoch: target.navigationEpoch + 1, url };
      snapshot = { ...snapshot, tabs: snapshot.tabs.map((tab) => (tab.id === tabId ? { ...tab, url } : tab)) };
      return snapshot;
    }),
    resolveAgentTab: mock((_contextId: string, tabId?: string) => ({ ...target, id: tabId ?? snapshot.activeTabId })),
    selectTab: mock((_contextId: string, tabId: string) => {
      snapshot = {
        ...snapshot,
        activeTabId: tabId,
        tabs: snapshot.tabs.map((tab) => ({ ...tab, active: tab.id === tabId })),
      };
      return snapshot;
    }),
    setViewport: mock(async () => true),
  } as unknown as BrowserPaneController;
  const authorizeCredentialNavigation = mock(async () => true);
  const authorizeOrigin = mock(async () => "session" as const);
  const controller = new BrowserAgentController(panes, { authorizeCredentialNavigation, authorizeOrigin });
  return {
    authorizeCredentialNavigation,
    authorizeOrigin,
    commands,
    controller,
    navigate: (url: string) => {
      target = { ...target, navigationEpoch: target.navigationEpoch + 1, url };
    },
    panes,
    setTwoTabs: () => {
      snapshot = {
        ...snapshot,
        tabs: [snapshot.tabs[0], { ...snapshot.tabs[0], active: false, id: "tab-2" }],
      };
    },
  };
}

describe("BrowserAgentController", () => {
  test("requires a session-owned Browser context", async () => {
    const { controller } = createFixture();
    await expect(controller.execute("session-1", { name: "tabs_context" })).resolves.toMatchObject({
      error: expect.stringContaining("open a Browser tile first"),
      ok: false,
    });
  });

  test("exposes the reference tab contract without page-authored titles", async () => {
    const { controller } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(controller.execute("session-1", { name: "tabs_context" })).resolves.toEqual({
      ok: true,
      result: { tabs: [{ isActive: true, origin: "https://example.com", tabId: "tab-1" }] },
    });
  });

  test("separates read approval from action approval and caches both", async () => {
    const { authorizeOrigin, controller } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(controller.execute("session-1", { name: "read_page" })).resolves.toMatchObject({
      ok: true,
      result: { content: expect.stringContaining("ref_1"), tabId: "tab-1" },
    });
    await controller.execute("session-1", { input: { action: "left_click", ref: "ref_1" }, name: "computer" });
    await controller.execute("session-1", { input: { action: "left_click", ref: "ref_1" }, name: "computer" });
    expect(authorizeOrigin).toHaveBeenCalledTimes(2);
    expect(authorizeOrigin.mock.calls.map(([value]) => value.access)).toEqual(["read", "action"]);
  });

  test("rejects a read when the tab changes during approval", async () => {
    const fixture = createFixture();
    const controller = new BrowserAgentController(fixture.panes, {
      authorizeCredentialNavigation: fixture.authorizeCredentialNavigation,
      authorizeOrigin: async () => {
        fixture.navigate("https://other.example/page");
        return "session";
      },
    });
    controller.bind("session-1", "context-1");
    await expect(controller.execute("session-1", { name: "read_page" })).resolves.toMatchObject({
      error: expect.stringContaining("changed while it was being approved"),
      ok: false,
    });
  });

  test("rejects navigation when the tab changes during destination approval", async () => {
    const fixture = createFixture();
    const controller = new BrowserAgentController(fixture.panes, {
      authorizeCredentialNavigation: fixture.authorizeCredentialNavigation,
      authorizeOrigin: async () => {
        fixture.navigate("https://other.example/page");
        return "session";
      },
    });
    controller.bind("session-1", "context-1");
    await expect(
      controller.execute("session-1", { input: { url: "https://destination.example" }, name: "navigate" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("changed while it was being approved"), ok: false });
    expect(fixture.panes.navigateAgentTab).not.toHaveBeenCalled();
  });

  test("uses screenshot-pixel coordinates and ref actions through CDP", async () => {
    const { commands, controller } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(
      controller.execute("session-1", { input: { action: "screenshot" }, name: "computer" }),
    ).resolves.toMatchObject({ ok: true, result: { height: 400, image: { mimetype: "image/jpeg" }, width: 800 } });
    await controller.execute("session-1", {
      input: { action: "left_click", coordinate: [400, 200] },
      name: "computer",
    });
    expect(commands).toContainEqual(expect.objectContaining({ method: "Input.dispatchMouseEvent", params: expect.objectContaining({ x: 600, y: 300 }) }));
    await controller.execute("session-1", { input: { action: "hover", ref: "ref_1" }, name: "computer" });
    expect(commands.some(({ method }) => method === "Input.dispatchMouseEvent")).toBe(true);
  });

  test("types into the focused element without requiring a coordinate or ref", async () => {
    const { commands, controller } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(
      controller.execute("session-1", { input: { action: "type", text: "hello" }, name: "computer" }),
    ).resolves.toMatchObject({ ok: true, result: { action: "type" } });
    expect(commands).toContainEqual({ method: "Input.insertText", params: { text: "hello" } });
  });

  test("supports one-shot origin approval without caching it", async () => {
    const fixture = createFixture();
    const authorizeOrigin = mock(async () => "once" as const);
    const controller = new BrowserAgentController(fixture.panes, {
      authorizeCredentialNavigation: fixture.authorizeCredentialNavigation,
      authorizeOrigin,
    });
    controller.bind("session-1", "context-1");
    await controller.execute("session-1", { name: "read_page" });
    await controller.execute("session-1", { name: "read_page" });
    expect(authorizeOrigin).toHaveBeenCalledTimes(2);
  });

  test("implements semantic form input, JavaScript, console, network, and viewport tools", async () => {
    const { controller, panes } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(
      controller.execute("session-1", { input: { ref: "ref_1", value: "hello" }, name: "form_input" }),
    ).resolves.toMatchObject({ ok: true, result: { ref: "ref_1" } });
    await expect(
      controller.execute("session-1", {
        input: { action: "javascript_exec", text: "({ inspected: true })" },
        name: "javascript_tool",
      }),
    ).resolves.toMatchObject({ ok: true, result: { result: { inspected: true } } });
    await expect(
      controller.execute("session-1", { input: { onlyErrors: true }, name: "read_console_messages" }),
    ).resolves.toMatchObject({ ok: true, result: { messages: [{ text: "boom" }] } });
    await expect(
      controller.execute("session-1", { input: { requestId: "request-1" }, name: "read_network_requests" }),
    ).resolves.toMatchObject({ ok: true, result: { body: "ok" } });
    await controller.execute("session-1", { input: { colorScheme: "dark", preset: "mobile" }, name: "resize_window" });
    expect(panes.setViewport).toHaveBeenCalledWith("context-1", "tab-1", { height: 812, mobile: true, width: 375 });
  });

  test("changes only color scheme when resize_window has no viewport inputs", async () => {
    const { controller, panes } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(
      controller.execute("session-1", { input: { colorScheme: "dark" }, name: "resize_window" }),
    ).resolves.toMatchObject({ ok: true, result: { colorScheme: "dark", viewport: null } });
    expect(panes.setViewport).not.toHaveBeenCalled();
  });

  test("creates, selects, and closes tabs but preserves the final tab", async () => {
    const { controller, setTwoTabs } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(controller.execute("session-1", { name: "tabs_close", input: { tabId: "tab-1" } })).resolves.toMatchObject({
      error: expect.stringContaining("last Browser tab"),
      ok: false,
    });
    setTwoTabs();
    await expect(controller.execute("session-1", { name: "tabs_select", input: { tabId: "tab-2" } })).resolves.toMatchObject({ ok: true });
    await expect(controller.execute("session-1", { name: "tabs_close", input: { tabId: "tab-2" } })).resolves.toMatchObject({ ok: true });
    await expect(controller.execute("session-1", { name: "tabs_create" })).resolves.toMatchObject({ ok: true });
  });

  test("supports URL previews but reports the cloud/local process boundary", async () => {
    const { controller } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(
      controller.execute("session-1", { input: { url: "http://example.org/path" }, name: "preview_start" }),
    ).resolves.toMatchObject({
      ok: true,
      result: { previewId: "session-1", tabId: "tab-2", url: "https://example.org/path" },
    });
    await expect(
      controller.execute("session-1", { input: { name: "frontend" }, name: "preview_start" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("cloud-hosted"), ok: false });
  });

  test("removes a blank preview tab when its destination is denied", async () => {
    const fixture = createFixture();
    fixture.authorizeOrigin.mockImplementation(async () => "deny");
    fixture.controller.bind("session-1", "context-1");
    await expect(
      fixture.controller.execute("session-1", {
        input: { url: "https://denied.example" },
        name: "preview_start",
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("User denied"), ok: false });
    expect(fixture.panes.closeTab).toHaveBeenCalledWith("context-1", "tab-2");
  });

  test("normalizes bare public and loopback addresses for navigation", async () => {
    const { controller, panes } = createFixture();
    controller.bind("session-1", "context-1");

    await controller.execute("session-1", { input: { url: "example.org/path" }, name: "navigate" });
    expect(panes.navigateAgentTab).toHaveBeenLastCalledWith("context-1", "tab-1", "https://example.org/path");

    await controller.execute("session-1", { input: { url: "localhost:3000/app" }, name: "navigate" });
    expect(panes.navigateAgentTab).toHaveBeenLastCalledWith("context-1", "tab-1", "http://localhost:3000/app");
  });

  test("requires a separate one-shot approval before submitting URL credentials", async () => {
    const fixture = createFixture();
    fixture.authorizeCredentialNavigation.mockImplementation(async () => false);
    fixture.controller.bind("session-1", "context-1");

    await expect(
      fixture.controller.execute("session-1", {
        input: { url: "https://user:password@example.org/private" },
        name: "navigate",
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("denied submitting URL credentials"), ok: false });
    expect(fixture.panes.navigateAgentTab).not.toHaveBeenCalled();
  });
});
