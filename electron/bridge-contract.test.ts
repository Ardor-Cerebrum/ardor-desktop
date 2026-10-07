import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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

describe("local Cerebrum bridge contract", () => {
  test("exposes only typed runtime operations and event subscriptions", () => {
    const localAgentChannels = DESKTOP_BRIDGE_CHANNELS.filter((channel) => channel.startsWith("desktop:local-agent:"));
    expect(localAgentChannels).toEqual([
      "desktop:local-agent:event",
      "desktop:local-agent:token-request",
      "desktop:local-agent:get-status",
      "desktop:local-agent:choose-project-folder",
      "desktop:local-agent:connect",
      "desktop:local-agent:request",
      "desktop:local-agent:operation-outcome",
      "desktop:local-agent:reply",
      "desktop:local-agent:provide-token",
      "desktop:local-agent:replay-events",
      "desktop:local-agent:replay-token-requests",
      "desktop:local-agent:get-thread-access",
      "desktop:local-agent:set-thread-access",
      "desktop:local-agent:get-thread-project-folder",
      "desktop:local-agent:set-thread-project-folder",
      "desktop:local-agent:list-mcp-servers",
      "desktop:local-agent:save-mcp-server",
      "desktop:local-agent:remove-mcp-server",
      "desktop:local-agent:logout",
    ]);
    expect(isDesktopBridgeChannel("desktop:local-agent:request")).toBe(true);
    expect(isDesktopBridgeChannel("desktop:local-agent:arbitrary")).toBe(false);

    const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(preload).toContain("localAgentV1: Object.freeze({");
    expect(preload).toContain('subscribe<LocalAgentTokenRequest>("desktop:local-agent:token-request", handler)');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:request"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:operation-outcome"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:replay-events"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:replay-token-requests"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:get-thread-access"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:set-thread-access"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:get-thread-project-folder"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:set-thread-project-folder"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:list-mcp-servers"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:save-mcp-server"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:remove-mcp-server"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:logout"');
    expect(main).toContain('registerBridgeHandler("desktop:local-agent:choose-project-folder"');
  });
});
