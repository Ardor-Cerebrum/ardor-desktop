import { describe, expect, test } from "bun:test";

import { DESKTOP_BRIDGE_CHANNELS, isDesktopBridgeChannel } from "./bridge-contract";

describe("desktop notification bridge contract", () => {
  test("allowlists only the three typed notification channels", () => {
    const notificationChannels = DESKTOP_BRIDGE_CHANNELS.filter((channel) =>
      channel.startsWith("desktop:notifications:"),
    );

    expect(notificationChannels).toEqual([
      "desktop:notifications:get-status",
      "desktop:notifications:show",
      "desktop:notifications:opened",
    ]);
    expect(isDesktopBridgeChannel("desktop:notifications:get-status")).toBe(true);
    expect(isDesktopBridgeChannel("desktop:notifications:show")).toBe(true);
    expect(isDesktopBridgeChannel("desktop:notifications:opened")).toBe(true);
    expect(isDesktopBridgeChannel("desktop:notifications:arbitrary")).toBe(false);
  });
});
