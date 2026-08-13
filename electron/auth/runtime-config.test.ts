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

  test("accepts only an entitlement-qualified Browser WebAuthn access group", () => {
    expect(
      parseDesktopRuntimeConfig({
        auth0Domain: "auth-dev.ardor.cloud",
        auth0ClientId: "stage-client-id",
        browserWebAuthnKeychainAccessGroup: "Q6L2SF6YDW.cloud.ardor.desktop.webauthn",
      }).browserWebAuthnKeychainAccessGroup,
    ).toBe("Q6L2SF6YDW.cloud.ardor.desktop.webauthn");
    expect(() =>
      parseDesktopRuntimeConfig({
        auth0Domain: "auth-dev.ardor.cloud",
        auth0ClientId: "stage-client-id",
        browserWebAuthnKeychainAccessGroup: "cloud.ardor.desktop.webauthn",
      }),
    ).toThrow("Browser WebAuthn keychain access group is invalid");
  });
});
