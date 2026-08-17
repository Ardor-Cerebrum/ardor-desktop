import { describe, expect, test } from "bun:test";

import { parseDesktopRuntimeConfig } from "./runtime-config";

describe("desktop runtime config", () => {
  test("accepts the stage Auth0 configuration embedded in a packaged build", () => {
    expect(
      parseDesktopRuntimeConfig({
        auth0Domain: "auth-dev.ardor.cloud",
        auth0ClientId: "stage-client-id",
      }),
    ).toEqual({
      auth0Domain: "auth-dev.ardor.cloud",
      auth0ClientId: "stage-client-id",
    });
  });

  test("rejects missing Auth0 configuration instead of silently disabling sign-in", () => {
    expect(() => parseDesktopRuntimeConfig({ auth0Domain: "", auth0ClientId: "" })).toThrow(
      "desktop Auth0 runtime config is incomplete",
    );
  });

  test("accepts only an explicit boolean auto-update boundary", () => {
    expect(
      parseDesktopRuntimeConfig({
        auth0Domain: "auth.ardor.cloud",
        auth0ClientId: "prod-client-id",
        autoUpdateEnabled: false,
      }).autoUpdateEnabled,
    ).toBe(false);
    expect(() =>
      parseDesktopRuntimeConfig({
        auth0Domain: "auth.ardor.cloud",
        auth0ClientId: "prod-client-id",
        autoUpdateEnabled: "false",
      }),
    ).toThrow("auto-update runtime config is invalid");
  });

  test("requires the complete signed Windows update configuration", () => {
    expect(
      parseDesktopRuntimeConfig({
        auth0Domain: "auth.ardor.cloud",
        auth0ClientId: "prod-client-id",
        autoUpdateEnabled: true,
        windowsUpdateFeedUrl: "https://github.com/Ardor-Cerebrum/ardor-desktop/releases/download/electron-update-feed/windows-x64.json",
        windowsUpdatePublicKey: "public-key",
      }),
    ).toMatchObject({
      windowsUpdateFeedUrl:
        "https://github.com/Ardor-Cerebrum/ardor-desktop/releases/download/electron-update-feed/windows-x64.json",
      windowsUpdatePublicKey: "public-key",
    });
    expect(() =>
      parseDesktopRuntimeConfig({
        auth0Domain: "auth.ardor.cloud",
        auth0ClientId: "prod-client-id",
        windowsUpdateFeedUrl: "https://updates.ardor.cloud/windows-x64.json",
      }),
    ).toThrow("Windows updater runtime config is incomplete");
  });
});
