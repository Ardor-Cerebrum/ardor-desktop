import assert from "node:assert/strict";
import test from "node:test";

import {
  renderBrowserWebAuthnEntitlements,
  resolveBrowserWebAuthnKeychainAccessGroup,
} from "./webauthn-signing.mjs";

test("derives the Browser WebAuthn group from the signed app identity", () => {
  const group = resolveBrowserWebAuthnKeychainAccessGroup({
    bundleId: "cloud.ardor.desktop",
    teamId: "Q6L2SF6YDW",
  });

  assert.equal(group, "Q6L2SF6YDW.cloud.ardor.desktop.webauthn");
  assert.match(renderBrowserWebAuthnEntitlements(group), /<key>keychain-access-groups<\/key>/);
  assert.match(renderBrowserWebAuthnEntitlements(group), new RegExp(group.replaceAll(".", "\\.")));
});

test("does not configure Touch ID for unsigned builds or invalid Team IDs", () => {
  assert.equal(
    resolveBrowserWebAuthnKeychainAccessGroup({ bundleId: "cloud.ardor.desktop", teamId: undefined }),
    undefined,
  );
  assert.throws(
    () =>
      resolveBrowserWebAuthnKeychainAccessGroup({
        bundleId: "cloud.ardor.desktop",
        teamId: "INVALID",
      }),
    /Apple Team ID/,
  );
});
