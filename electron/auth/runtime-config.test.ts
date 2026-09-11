import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ARDOR_PROVIDER_RUNTIME_CONFIG,
  parseDesktopRuntimeConfig,
  resolveArdorProviderRuntimeConfig,
} from "./runtime-config";

describe("desktop runtime config", () => {
  test("defaults every Ardor product endpoint to production", () => {
    expect(resolveArdorProviderRuntimeConfig()).toEqual(DEFAULT_ARDOR_PROVIDER_RUNTIME_CONFIG);
  });

  test("reads complete Ardor endpoint overrides from Cerebrum config", () => {
    expect(
      resolveArdorProviderRuntimeConfig({
        config: {
          providers: {
            ardor: {
              base_url: "https://qa.dev.ardor.cloud/",
              artifact_base_url: "https://qa.artifact.ardor.build/artifact-api/",
              auth0_domain: "auth-dev.ardor.cloud",
              auth0_client_id: "qa-client-id",
            },
          },
        },
      }),
    ).toEqual({
      baseUrl: "https://qa.dev.ardor.cloud",
      artifactBaseUrl: "https://qa.artifact.ardor.build/artifact-api",
      auth0Domain: "auth-dev.ardor.cloud",
      auth0ClientId: "qa-client-id",
    });
  });

  test("uses production defaults for omitted Ardor endpoint fields", () => {
    expect(
      resolveArdorProviderRuntimeConfig({
        config: { providers: { ardor: { base_url: "https://qa.dev.ardor.cloud" } } },
      }),
    ).toEqual({
      ...DEFAULT_ARDOR_PROVIDER_RUNTIME_CONFIG,
      baseUrl: "https://qa.dev.ardor.cloud",
    });
  });

  test("rejects unsafe Ardor endpoint overrides", () => {
    expect(() =>
      resolveArdorProviderRuntimeConfig({
        config: { providers: { ardor: { base_url: "http://qa.dev.ardor.cloud" } } },
      }),
    ).toThrow("providers.ardor.base_url must be public HTTPS or loopback HTTP");
    expect(() =>
      resolveArdorProviderRuntimeConfig({
        config: { providers: { ardor: { auth0_domain: "auth-dev.ardor.cloud/path" } } },
      }),
    ).toThrow("providers.ardor.auth0_domain must contain only a hostname");
  });

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
