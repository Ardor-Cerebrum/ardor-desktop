import assert from "node:assert/strict";
import test from "node:test";

import {
  hasRealMacSigningIdentity,
  renderBrowserWebAuthnEntitlements,
  resolveBrowserWebAuthnKeychainAccessGroup,
} from "./webauthn-signing.mjs";

test("derives the Browser WebAuthn group from the signed app identity", () => {
  const group = resolveBrowserWebAuthnKeychainAccessGroup({
    bundleId: "cloud.ardor.desktop",
    signingIdentity: "Developer ID Application: Ardor",
    teamId: "Q6L2SF6YDW",
  });

  assert.equal(group, "Q6L2SF6YDW.cloud.ardor.desktop.webauthn");
  assert.match(renderBrowserWebAuthnEntitlements(group), /<key>keychain-access-groups<\/key>/);
  assert.match(renderBrowserWebAuthnEntitlements(group), new RegExp(group.replaceAll(".", "\\.")));
});

test("does not configure Touch ID for unsigned builds or invalid Team IDs", () => {
  assert.equal(hasRealMacSigningIdentity(undefined), false);
  assert.equal(hasRealMacSigningIdentity("-"), false);
  assert.equal(hasRealMacSigningIdentity("Developer ID Application: Ardor"), true);
  assert.equal(
    resolveBrowserWebAuthnKeychainAccessGroup({
      bundleId: "cloud.ardor.desktop",
      signingIdentity: undefined,
      teamId: "Q6L2SF6YDW",
    }),
    undefined,
  );
  assert.equal(
    resolveBrowserWebAuthnKeychainAccessGroup({
      bundleId: "cloud.ardor.desktop",
      signingIdentity: "-",
      teamId: "Q6L2SF6YDW",
    }),
    undefined,
  );
  assert.equal(
    resolveBrowserWebAuthnKeychainAccessGroup({
      bundleId: "cloud.ardor.desktop",
      signingIdentity: "Developer ID Application: Ardor",
      teamId: undefined,
    }),
    undefined,
  );
  assert.throws(
    () =>
      resolveBrowserWebAuthnKeychainAccessGroup({
        bundleId: "cloud.ardor.desktop",
        signingIdentity: "Developer ID Application: Ardor",
        teamId: "INVALID",
      }),
    /Apple Team ID/,
  );
});
