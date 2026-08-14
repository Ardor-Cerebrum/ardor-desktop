import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");

test("release matrices follow the immutable macOS signing plan", () => {
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.match(
    workflow,
    /macos_release_mode:\n\s+description:.*\n\s+required: true\n\s+type: choice\n\s+options:\n\s+- developer-id\n\s+- macos-adhoc\n\s+default: developer-id/,
  );
  assert.match(workflow, /Desktop releases must be dispatched from the main branch/);
  assert.match(workflow, /developer-id\) requested_mode=developer-id/);
  assert.match(workflow, /macos-adhoc\) requested_mode=ad-hoc/);
  assert.match(workflow, /Requested macOS release mode .* does not match the configured Apple credential mode/);
  assert.match(workflow, /release_asset_matrix:.*macos-release-plan\.outputs\.asset_matrix/);
  assert.match(workflow, /release_ui_platforms:.*macos-release-plan\.outputs\.ui_platforms/);
  assert.match(workflow, /matrix:.*fromJSON\(needs\.release\.outputs\.release_asset_matrix\)/);
  assert.match(workflow, /target_platform:.*fromJSON\(needs\.release\.outputs\.release_ui_platforms\)/);
  assert.match(workflow, /ardor-macos-signing-mode:\$\{MACOS_RELEASE_SIGNING_MODE\}/);
  assert.match(workflow, /prerelease state does not match its immutable macOS mode/);
  assert.match(
    workflow,
    /APPLE_SIGNING_IDENTITY:.*macos_signing_mode == 'developer-id'.*secrets\.APPLE_SIGNING_IDENTITY \|\| ''/,
  );
});

test("ad-hoc publication stays a manual prerelease while signed publication stays latest", () => {
  assert.match(
    workflow,
    /if \[ "\$\{\{ needs\.release\.outputs\.macos_signing_mode \}\}" = "ad-hoc" \]; then[\s\S]*--draft=false --prerelease[\s\S]*--draft=false --prerelease=false --latest/,
  );
  assert.match(workflow, /diff -u .*expected-release-assets\.txt.*actual-release-assets\.txt/);
  assert.match(workflow, /gh release upload[^\n]*--clobber/);
  assert.match(workflow, /no longer contains exactly one immutable macOS signing-mode marker/);
  assert.match(workflow, /no longer contains the required ad-hoc distribution warning/);
});

test("ad-hoc packages are verified without updater or Keychain capabilities", () => {
  assert.match(workflow, /Verify ad-hoc macOS distribution boundary/);
  assert.match(workflow, /Signature=adhoc/);
  assert.match(workflow, /browserWebAuthnKeychainAccessGroup/);
  assert.match(workflow, /config\.autoUpdateEnabled !== false/);
  assert.match(main, /updatesEnabled: runtimeConfig\?\.autoUpdateEnabled === true/);
});

test("CI packages and mounts the real production ad-hoc macOS distribution", () => {
  assert.match(ciWorkflow, /Make production ad-hoc macOS shell with a UI fixture/);
  assert.match(ciWorkflow, /electron-stage-build\.mjs prod --platform darwin/);
  assert.match(ciWorkflow, /ARDOR_ELECTRON_CHANNEL: prod/);
  assert.match(ciWorkflow, /MACOS_RELEASE_SIGNING_MODE: ad-hoc/);
  assert.match(ciWorkflow, /cloud\.ardor\.desktop/);
  assert.match(ciWorkflow, /Signature=adhoc/);
  assert.match(ciWorkflow, /TeamIdentifier=\[A-Z0-9\]\+/);
  assert.match(ciWorkflow, /<key>keychain-access-groups<\/key>/);
  assert.match(ciWorkflow, /"browserWebAuthnKeychainAccessGroup" in config/);
  assert.match(ciWorkflow, /config\.autoUpdateEnabled !== false/);
  assert.match(ciWorkflow, /-unsigned\.dmg/);
  assert.match(ciWorkflow, /must not collect an updater ZIP/);
  assert.match(ciWorkflow, /verify_ad_hoc_app "\$mount_dir\/Ardor\.app" dmg/);
});
