import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DESKTOP_BRIDGE_CHANNELS,
  isDesktopBridgeChannel,
  parseBrowserPaneOpenLinkMode,
  parseBrowserPaneOpenLinkRequest,
  parseBrowserProfileScope,
} from "../electron/bridge-contract";

test("exposes only explicit desktop bridge channels", () => {
  expect(DESKTOP_BRIDGE_CHANNELS).toEqual([
    "desktop:runtime:get-info",
    "desktop:window:get-fullscreen",
    "desktop:window:fullscreen-changed",
    "desktop:auth:get-callback-status",
    "desktop:auth:get-pending-callback",
    "desktop:auth:complete-callback",
    "desktop:auth:open-url",
    "desktop:external:open-url",
    "desktop:auth:logout",
    "desktop:auth:callback-ready",
    "desktop:update:check",
    "desktop:update:install",
    "desktop:update:relaunch",
    "desktop:update:event",
    "desktop:sidebar-browser:address-changed",
    "desktop:sidebar-browser:automate",
    "desktop:sidebar-browser:open",
    "desktop:sidebar-browser:get-active-tab",
    "desktop:sidebar-browser:layout",
    "desktop:sidebar-browser:control",
    "desktop:sidebar-browser:input",
    "desktop:sidebar-browser:close",
    "desktop:browser-pane:state-changed",
    "desktop:browser-pane:navigation-blocked",
    "desktop:browser-pane:element-selected",
    "desktop:browser-pane:selection-shortcut",
    "desktop:browser-pane:focus-exit",
    "desktop:browser-pane:open",
    "desktop:browser-pane:claim",
    "desktop:browser-pane:release",
    "desktop:browser-pane:get-state",
    "desktop:browser-pane:open-link",
    "desktop:browser-pane:create-tab",
    "desktop:browser-pane:select-tab",
    "desktop:browser-pane:close-tab",
    "desktop:browser-pane:move-tab",
    "desktop:browser-pane:navigate",
    "desktop:browser-pane:control",
    "desktop:browser-pane:layout",
    "desktop:browser-pane:capture",
    "desktop:browser-pane:automate",
    "desktop:browser-pane:toggle-element-selection",
    "desktop:browser-pane:focus",
    "desktop:browser-pane:close",
    "desktop:artifact-pane:open",
    "desktop:artifact-pane:layout",
    "desktop:artifact-pane:reload",
    "desktop:artifact-pane:capture",
    "desktop:artifact-pane:automate",
    "desktop:artifact-pane:close",
    "desktop:browser-profile:get-settings",
    "desktop:browser-profile:update-storage-mode",
    "desktop:browser-profile:update-preferences",
    "desktop:browser-profile:delete-credential",
    "desktop:browser-profile:fill-credential",
    "desktop:browser-profile:resolve-credential-prompt",
    "desktop:browser-profile:clear-download-history",
    "desktop:browser-profile:open-downloads",
    "desktop:browser-profile:list-site-data",
    "desktop:browser-profile:clear-site-data",
    "desktop:browser-profile:credential-options",
    "desktop:browser-profile:save-password-prompt",
    "desktop:browser-profile:downloads-changed",
  ]);

  expect(isDesktopBridgeChannel("desktop:auth:get-callback-status")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:external:open-url")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:move-tab")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:navigation-blocked")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:element-selected")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:selection-shortcut")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:focus-exit")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser:automate")).toBe(false);
  expect(isDesktopBridgeChannel("ipcRenderer:send")).toBe(false);
});

test("wires native element selection through explicit pane channels", () => {
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");

  expect(preload).toContain('subscribe<BrowserPaneElementSelectedEvent>("desktop:browser-pane:element-selected", handler)');
  expect(preload).toContain(
    'subscribe<BrowserPaneSelectionShortcutEvent>("desktop:browser-pane:selection-shortcut", handler)',
  );
  expect(preload).toContain('subscribe<BrowserPaneFocusExitEvent>("desktop:browser-pane:focus-exit", handler)');
  expect(preload).toContain('invoke<boolean>("desktop:browser-pane:toggle-element-selection", contextId, tabId, enabled)');
  expect(preload).toContain('invoke<boolean>("desktop:browser-pane:focus", contextId)');
  expect(main).toContain('registerBridgeHandler("desktop:browser-pane:toggle-element-selection"');
});

test("accepts only bounded browser profile scopes", () => {
  expect(parseBrowserProfileScope(undefined)).toBeUndefined();
  expect(parseBrowserProfileScope({ workspaceId: "workspace-a", sessionId: "session-a" })).toEqual({
    workspaceId: "workspace-a",
    sessionId: "session-a",
  });
  expect(() => parseBrowserProfileScope({ workspaceId: "", sessionId: "session-a" })).toThrow(
    "profile scope is invalid",
  );
  expect(() => parseBrowserProfileScope("workspace-a")).toThrow("profile scope is invalid");
});

test("accepts only explicit browser link opening modes", () => {
  expect(parseBrowserPaneOpenLinkMode("reload-existing")).toBe("reload-existing");
  expect(parseBrowserPaneOpenLinkMode("focus-existing")).toBe("focus-existing");
  expect(() => parseBrowserPaneOpenLinkMode("create-new")).toThrow("open-link mode is invalid");
  expect(() => parseBrowserPaneOpenLinkMode(undefined)).toThrow("open-link mode is invalid");
  expect(parseBrowserPaneOpenLinkRequest("browser:one", "https://example.com/", "focus-existing")).toEqual([
    "browser:one",
    "https://example.com/",
    "focus-existing",
  ]);
  expect(() => parseBrowserPaneOpenLinkRequest(42, "https://example.com/", "focus-existing")).toThrow(
    "open-link request is invalid",
  );
});

test("wires browser link opening through preload and validated main IPC", () => {
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");

  expect(preload).toContain('openLink: (contextId: string, url: string, mode: BrowserPaneOpenLinkMode) =>');
  expect(preload).toContain('invoke<BrowserPaneSnapshot>("desktop:browser-pane:open-link", contextId, url, mode)');
  expect(main).toContain('registerBridgeHandler("desktop:browser-pane:open-link"');
  expect(main).toContain("openLink(...parseBrowserPaneOpenLinkRequest(contextId, url, mode))");
});
