import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DESKTOP_BRIDGE_CHANNELS,
  isDesktopBridgeChannel,
  parseBrowserPaneOpenLinkMode,
  parseBrowserPaneOpenLinkRequest,
  parseBrowserPaneColorScheme,
  parseBrowserProfileScope,
  parseBrowserPaneViewport,
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
    "desktop:agent:get-status",
    "desktop:agent:request",
    "desktop:agent:respond",
    "desktop:agent:select-workspace",
    "desktop:agent:message",
    "desktop:update:check",
    "desktop:update:install",
    "desktop:update:relaunch",
    "desktop:update:event",
    "desktop:browser-pane:state-changed",
    "desktop:browser-pane:navigation-blocked",
    "desktop:browser-pane:media-permission-denied",
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
    "desktop:browser-pane:set-color-scheme",
    "desktop:browser-pane:set-viewport",
    "desktop:browser-pane:close",
    "desktop:artifact-pane:open",
    "desktop:artifact-pane:layout",
    "desktop:artifact-pane:reload",
    "desktop:artifact-pane:capture",
    "desktop:artifact-pane:automate",
    "desktop:artifact-pane:close",
    "desktop:terminal:event",
    "desktop:terminal:list-profiles",
    "desktop:terminal:open",
    "desktop:terminal:detach",
    "desktop:terminal:restart",
    "desktop:terminal:write",
    "desktop:terminal:resize",
    "desktop:terminal:ack",
    "desktop:terminal:clear",
    "desktop:terminal:close",
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
  expect(isDesktopBridgeChannel("desktop:agent:request")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:move-tab")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:navigation-blocked")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:media-permission-denied")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:element-selected")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:selection-shortcut")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser-pane:focus-exit")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:terminal:write")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser:automate")).toBe(false);
  expect(isDesktopBridgeChannel("ipcRenderer:send")).toBe(false);
});

test("keeps Cerebrum behind the typed preload bridge", () => {
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../electron/cerebrum/app-server-client.ts", import.meta.url), "utf8");

  expect(preload).toContain('invoke<unknown>("desktop:agent:request", method, params ?? {})');
  expect(main).toContain("CEREBRUM_CLIENT_METHODS.includes");
  expect(main).toContain('registerBridgeHandler("desktop:agent:select-workspace"');
  expect(client).toContain('["--profile", "ardor-desktop", "app-server", "--stdio"]');
  expect(client).not.toContain("internalAccessToken");
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
  expect(preload).toContain('invoke<boolean>("desktop:browser-pane:set-color-scheme", contextId, colorScheme)');
  expect(main).toContain('registerBridgeHandler("desktop:browser-pane:set-color-scheme"');
  expect(preload).toContain(
    'invoke<boolean>("desktop:browser-pane:set-viewport", contextId, tabId, viewport)',
  );
  expect(main).toContain('registerBridgeHandler("desktop:browser-pane:set-viewport"');
  expect(main).toContain('registerBridgeHandler("desktop:browser-pane:toggle-element-selection"');
});

test("installs sole-account WebAuthn selection for browser sessions", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const host = readFileSync(new URL("../electron/browser/webcontents-host.ts", import.meta.url), "utf8");

  expect(main).toContain("installSoleWebAuthnAccountSelection(session.defaultSession)");
  expect(main).toContain("const updatesEnabled = runtimeConfig?.autoUpdateEnabled === true");
  expect(main).toContain("createSparkleDesktopUpdater({");
  expect(main).toContain("createSecureWindowsUpdater({");
  expect(host).toContain("installSoleWebAuthnAccountSelection(webContents.session)");
});

test("persists Browser state before native window teardown and application quit", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const closeHandler = main.slice(main.indexOf('window.on("close"'), main.indexOf('window.on("closed"'));
  const quitHandler = main.slice(main.indexOf('app.on("before-quit"'));

  expect(main).toContain("browserProfileSessionService?.flushPersistentData()");
  expect(closeHandler).toContain("flushBrowserPersistentData()");
  expect(closeHandler).toContain("event.preventDefault()");
  expect(closeHandler).toContain("disposeNativePanes()");
  expect(closeHandler).toContain("window.destroy()");
  expect(quitHandler).toContain("event.preventDefault()");
  expect(quitHandler).toContain("flushBrowserPersistentData()");
  expect(quitHandler).toContain("quitForUpdate");
  expect(quitHandler).toContain("app.quit()");
  expect(main).toContain('autoUpdater.on("before-quit-for-update"');
  expect(main).toContain("beforeRelaunch:");
});

test("selects the packaged application profile before Electron session initialization", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const setNameIndex = main.indexOf("app.setName(applicationName)");
  const setUserDataIndex = main.indexOf('app.setPath("userData"');
  const singleInstanceIndex = main.indexOf("app.requestSingleInstanceLock()");

  expect(setNameIndex).toBeGreaterThan(-1);
  expect(setUserDataIndex).toBeGreaterThan(setNameIndex);
  expect(singleInstanceIndex).toBeGreaterThan(setUserDataIndex);
  expect(main).toContain("resolveWindowsAppUserModelId(desktopChannel)");
  expect(main).toContain("channel: desktopChannel");
});

test("does not start the normal application during Squirrel lifecycle events", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const squirrelGuardIndex = main.indexOf("const shouldStartDesktopApplication = !electronSquirrelStartup");
  const singleInstanceIndex = main.indexOf("app.requestSingleInstanceLock()");
  const readyIndex = main.indexOf("app.whenReady()");

  expect(main).toContain('import electronSquirrelStartup from "electron-squirrel-startup"');
  expect(main).toContain(
    "if (shouldStartDesktopApplication && !isPackagedTerminalSmoke && !app.requestSingleInstanceLock())",
  );
  expect(main).toContain("} else if (shouldStartDesktopApplication) {");
  expect(squirrelGuardIndex).toBeGreaterThan(-1);
  expect(singleInstanceIndex).toBeGreaterThan(squirrelGuardIndex);
  expect(readyIndex).toBeGreaterThan(squirrelGuardIndex);
});

test("opens OAuth only after the callback listener is ready", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const handlerStart = main.indexOf('registerBridgeHandler("desktop:auth:open-url"');
  const handlerEnd = main.indexOf('registerBridgeHandler("desktop:external:open-url"', handlerStart);
  const handler = main.slice(handlerStart, handlerEnd);

  expect(handler).toContain("await requireListeningAuthCallbackServer()");
  expect(handler).toContain("const authorizationId = server.beginAuthorization(value)");
  expect(handler).toContain("server.cancelAuthorization(authorizationId)");
  expect(handler.indexOf("await requireListeningAuthCallbackServer()")).toBeLessThan(
    handler.indexOf("shell.openExternal(value)"),
  );
  expect(main).toContain('console.error("Desktop auth callback server failed to start", cause)');
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

test("accepts only bounded browser viewport presets", () => {
  expect(parseBrowserPaneViewport(null)).toBeNull();
  expect(parseBrowserPaneViewport({ width: 375, height: 812, mobile: true })).toEqual({
    width: 375,
    height: 812,
    mobile: true,
  });
  expect(() => parseBrowserPaneViewport({ width: 0, height: 812, mobile: true })).toThrow("viewport is invalid");
  expect(() => parseBrowserPaneViewport({ width: 375, height: 812, mobile: "yes" })).toThrow("viewport is invalid");
});

test("accepts only explicit browser color schemes", () => {
  expect(parseBrowserPaneColorScheme("light")).toBe("light");
  expect(parseBrowserPaneColorScheme("dark")).toBe("dark");
  expect(() => parseBrowserPaneColorScheme("system")).toThrow("color scheme is invalid");
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
