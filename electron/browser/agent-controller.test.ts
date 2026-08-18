import { describe, expect, mock, test } from "bun:test";

import type { BrowserPaneSnapshot } from "../bridge-contract";
import type { BrowserTabHandle } from "./browser-surface";
import { BrowserAgentController } from "./agent-controller";
import type { BrowserAgentTabTarget, BrowserPaneController } from "./pane-controller";

const SNAPSHOT: BrowserPaneSnapshot = {
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

function createFixture() {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let target: BrowserAgentTabTarget = {
    generation: 1,
    handle: {
      sendCommand: mock(async (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, params });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === "Runtime.evaluate" && String(params?.expression).includes("getBoundingClientRect")) {
          return { result: { value: { ok: true, x: 10, y: 20 } } };
        }
        if (method === "Runtime.evaluate" && String(params?.expression).includes("element.focus()")) {
          return { result: { value: { ok: true } } };
        }
        if (method !== "Runtime.evaluate") return {};
        return {
          result: {
            value: {
              elements: [{ name: "Continue", ref: "ref_1", role: "button" }],
              title: "Example",
              truncated: false,
              url: "https://example.com/page",
            },
          },
        };
      }),
    } as unknown as BrowserTabHandle,
    id: "tab-1",
    navigationEpoch: 3,
    url: "https://example.com/page",
  };
  const panes = {
    getState: mock(() => SNAPSHOT),
    navigateAgentTab: mock(async (_contextId: string, _tabId: string, url: string) => {
      target = { ...target, navigationEpoch: target.navigationEpoch + 1, url };
      return { ...SNAPSHOT, tabs: [{ ...SNAPSHOT.tabs[0], url }] };
    }),
    resolveAgentTab: mock(() => target),
  } as unknown as BrowserPaneController;
  const authorizeOrigin = mock(async () => true);
  const controller = new BrowserAgentController(panes, { authorizeOrigin });
  return {
    authorizeOrigin,
    commands,
    controller,
    panes,
    navigate: (url: string) => {
      target = { ...target, navigationEpoch: target.navigationEpoch + 1, url };
    },
  };
}

describe("BrowserAgentController", () => {
  test("requires a session binding", async () => {
    const { controller } = createFixture();
    await expect(controller.execute("session-1", { name: "tabs_context" })).resolves.toEqual({
      error: "No Browser tile is attached to this chat session",
      ok: false,
    });
  });

  test("lists only tabs from the bound Browser context", async () => {
    const { controller } = createFixture();
    controller.bind("session-1", "context-1");
    await expect(controller.execute("session-1", { name: "tabs_context" })).resolves.toMatchObject({
      ok: true,
      result: {
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", origin: "https://example.com" }],
      },
    });
  });

  test("lists every Browser tile attached to the same chat session", async () => {
    const snapshots = new Map([
      ["context-1", SNAPSHOT],
      [
        "context-2",
        {
          ...SNAPSHOT,
          activeTabId: "tab-2",
          contextId: "context-2",
          tabs: [{ ...SNAPSHOT.tabs[0], id: "tab-2", title: "Second", url: "https://second.example/" }],
        },
      ],
    ]);
    const panes = {
      getState: (contextId: string) => snapshots.get(contextId) ?? null,
    } as unknown as BrowserPaneController;
    const controller = new BrowserAgentController(panes, { authorizeOrigin: async () => true });
    controller.bind("session-1", "context-1");
    controller.bind("session-1", "context-2");

    await expect(controller.execute("session-1", { name: "tabs_context" })).resolves.toMatchObject({
      ok: true,
      result: {
        activeTabId: "tab-2",
        tabs: [
          { contextId: "context-1", id: "tab-1" },
          { active: true, contextId: "context-2", id: "tab-2" },
        ],
      },
    });
  });

  test("approves an origin once and returns a bounded semantic snapshot", async () => {
    const { authorizeOrigin, controller } = createFixture();
    controller.bind("session-1", "context-1");

    const first = await controller.execute("session-1", { name: "read_page" });
    const second = await controller.execute("session-1", { name: "read_page" });

    expect(first).toMatchObject({
      ok: true,
      result: { navigationEpoch: 3, origin: "https://example.com", tabId: "tab-1" },
    });
    expect(second.ok).toBe(true);
    expect(authorizeOrigin).toHaveBeenCalledTimes(1);
  });

  test("does not disclose a page that navigated during approval", async () => {
    const fixture = createFixture();
    fixture.controller.dispose();
    const authorizeOrigin = mock(async () => {
      fixture.navigate("https://other.example/page");
      return true;
    });
    const controller = new BrowserAgentController(fixture.panes, { authorizeOrigin });
    controller.bind("session-1", "context-1");

    await expect(controller.execute("session-1", { name: "read_page" })).resolves.toMatchObject({
      error: expect.stringContaining("navigated while it was being approved"),
      ok: false,
    });
  });

  test("upgrades public HTTP navigation and approves the destination origin", async () => {
    const { authorizeOrigin, controller, panes } = createFixture();
    controller.bind("session-1", "context-1");

    await expect(
      controller.execute("session-1", {
        input: { url: "http://example.org/path" },
        name: "navigate",
      }),
    ).resolves.toMatchObject({ ok: true, result: { url: "https://example.org/path" } });
    expect(authorizeOrigin).toHaveBeenCalledWith({
      origin: "https://example.org",
      sessionId: "session-1",
      tool: "navigate",
    });
    expect(panes.navigateAgentTab).toHaveBeenCalledWith("context-1", "tab-1", "https://example.org/path");
  });

  test("clicks only a ref from read_page through trusted CDP commands", async () => {
    const { commands, controller } = createFixture();
    controller.bind("session-1", "context-1");

    await expect(
      controller.execute("session-1", { input: { ref: "ref_1" }, name: "click" }),
    ).resolves.toMatchObject({ ok: true, result: { clicked: "ref_1" } });
    expect(commands.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(3);
    await expect(
      controller.execute("session-1", { input: { ref: "body > button" }, name: "click" }),
    ).resolves.toMatchObject({ error: expect.stringContaining("ref is invalid"), ok: false });
  });

  test("types through a resolved ref and blocks sensitive-field automation in the page program", async () => {
    const { commands, controller } = createFixture();
    controller.bind("session-1", "context-1");

    await expect(
      controller.execute("session-1", {
        input: { ref: "ref_1", submit: true, text: "hello" },
        name: "type",
      }),
    ).resolves.toMatchObject({ ok: true, result: { edited: "ref_1" } });
    expect(commands.some(({ method, params }) => method === "Input.insertText" && params?.text === "hello")).toBe(
      true,
    );
    const evaluation = commands.find(
      ({ method, params }) => method === "Runtime.evaluate" && String(params?.expression).includes("element.focus()"),
    );
    expect(evaluation?.params?.expression).toContain("one-time-code");
  });
});
