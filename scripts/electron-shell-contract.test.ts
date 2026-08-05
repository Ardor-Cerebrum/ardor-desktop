import { expect, test } from "bun:test";

import {
  DESKTOP_BRIDGE_CHANNELS,
  isDesktopBridgeChannel,
} from "../electron/bridge-contract";

test("exposes only explicit desktop bridge channels", () => {
  expect(DESKTOP_BRIDGE_CHANNELS).toEqual([
    "desktop:runtime:get-info",
    "desktop:auth:get-status",
    "desktop:auth:open-url",
    "desktop:update:get-status",
    "desktop:update:check",
    "desktop:browser:get-status",
  ]);

  expect(isDesktopBridgeChannel("desktop:auth:get-status")).toBe(true);
  expect(isDesktopBridgeChannel("desktop:browser:automate")).toBe(false);
  expect(isDesktopBridgeChannel("ipcRenderer:send")).toBe(false);
});
