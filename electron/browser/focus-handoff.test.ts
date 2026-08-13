import { describe, expect, mock, test } from "bun:test";

import { handOffBrowserFocusToChrome, type BrowserFocusExitHost } from "./focus-handoff";

const focusExitEvent = { contextId: "browser:one", tabId: "tab-1" };

function createHost(destroyed = false) {
  const calls: string[] = [];
  const host: BrowserFocusExitHost = {
    isDestroyed: () => destroyed,
    webContents: {
      focus: mock(() => calls.push("focus")),
      send: mock((channel, event) => calls.push(`${channel}:${event.tabId}`)),
    },
  };
  return { calls, host };
}

describe("browser focus handoff", () => {
  test("focuses the owning renderer before dispatching the focus-exit event", () => {
    const fixture = createHost();

    expect(handOffBrowserFocusToChrome(fixture.host, focusExitEvent)).toBe(true);
    expect(fixture.calls).toEqual(["focus", "desktop:browser-pane:focus-exit:tab-1"]);
  });

  test("does nothing after the host window is destroyed", () => {
    const fixture = createHost(true);

    expect(handOffBrowserFocusToChrome(fixture.host, focusExitEvent)).toBe(false);
    expect(fixture.calls).toEqual([]);
  });
});
