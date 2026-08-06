import { expect, test } from "bun:test";

import {
  DESKTOP_BRIDGE_CHANNELS,
  isDesktopBridgeChannel,
} from "../electron/bridge-contract";

test("exposes only explicit desktop bridge channels", () => {
  expect(DESKTOP_BRIDGE_CHANNELS).toEqual([
    "desktop:runtime:get-info",
    "desktop:auth:get-callback-status",
    "desktop:auth:get-pending-callback",
    "desktop:auth:complete-callback",
    "desktop:auth:open-url",
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
    "desktop:browser-profile:get-settings",
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
  expect(isDesktopBridgeChannel("desktop:browser:automate")).toBe(false);
  expect(isDesktopBridgeChannel("ipcRenderer:send")).toBe(false);
});
