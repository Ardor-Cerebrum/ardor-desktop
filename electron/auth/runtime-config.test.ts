import { describe, expect, test } from "bun:test";

import { parseDesktopRuntimeConfig, resolveDesktopRuntimeConfig } from "./runtime-config";

describe("desktop runtime config", () => {
  test("accepts the stage Auth0 configuration embedded in a packaged build", () => {
    expect(
      parseDesktopRuntimeConfig({
        auth0Domain: "auth-dev.ardor.cloud",
        auth0ClientId: "stage-client-id",
        identityBffBaseUrl: "https://identity.stage.ardor.cloud",
      }),
    ).toEqual({
      auth0Domain: "auth-dev.ardor.cloud",
      auth0ClientId: "stage-client-id",
      identityBffBaseUrl: "https://identity.stage.ardor.cloud",
    });
  });

  test("requires an exact HTTPS or loopback HTTP identity BFF base URL", () => {
    const base = { auth0Domain: "auth.ardor.cloud", auth0ClientId: "client" };
    expect(parseDesktopRuntimeConfig({ ...base, identityBffBaseUrl: "https://identity.ardor.cloud" }).identityBffBaseUrl)
      .toBe("https://identity.ardor.cloud");
    expect(parseDesktopRuntimeConfig({ ...base, identityBffBaseUrl: "http://127.0.0.1:8000" }).identityBffBaseUrl)
      .toBe("http://127.0.0.1:8000");
    for (const identityBffBaseUrl of [
      "http://identity.ardor.cloud",
      "http://localhost.attacker.test",
      "https://user:pass@identity.ardor.cloud",
      "https://identity.ardor.cloud/path",
      "https://identity.ardor.cloud?query=1",
      "https://identity.ardor.cloud/#fragment",
    ]) {
      expect(() => parseDesktopRuntimeConfig({ ...base, identityBffBaseUrl })).toThrow(
        "identity BFF runtime config is invalid",
      );
    }
  });

  test("resolves the BFF URL from the main-process environment only", () => {
    expect(resolveDesktopRuntimeConfig({
      VITE_AUTH0_DOMAIN: "auth.ardor.cloud",
      VITE_AUTH0_CLIENT_ID: "client",
      ARDOR_IDENTITY_BFF_BASE_URL: "https://identity.ardor.cloud",
    })).toMatchObject({ identityBffBaseUrl: "https://identity.ardor.cloud" });
    expect(() => resolveDesktopRuntimeConfig({
      VITE_AUTH0_DOMAIN: "auth.ardor.cloud",
      VITE_AUTH0_CLIENT_ID: "client",
      VITE_IDENTITY_BFF_BASE_URL: "https://identity.ardor.cloud",
    })).toThrow("identity BFF runtime config is invalid");
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
        identityBffBaseUrl: "https://identity.ardor.cloud",
        autoUpdateEnabled: false,
      }).autoUpdateEnabled,
    ).toBe(false);
    expect(() =>
      parseDesktopRuntimeConfig({
        auth0Domain: "auth.ardor.cloud",
        auth0ClientId: "prod-client-id",
        identityBffBaseUrl: "https://identity.ardor.cloud",
        autoUpdateEnabled: "false",
      }),
    ).toThrow("auto-update runtime config is invalid");
  });

  test("requires the complete signed Windows update configuration", () => {
    expect(
      parseDesktopRuntimeConfig({
        auth0Domain: "auth.ardor.cloud",
        auth0ClientId: "prod-client-id",
        identityBffBaseUrl: "https://identity.ardor.cloud",
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
        identityBffBaseUrl: "https://identity.ardor.cloud",
        windowsUpdateFeedUrl: "https://updates.ardor.cloud/windows-x64.json",
      }),
    ).toThrow("Windows updater runtime config is incomplete");
  });
});
