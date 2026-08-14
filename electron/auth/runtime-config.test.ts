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
});
