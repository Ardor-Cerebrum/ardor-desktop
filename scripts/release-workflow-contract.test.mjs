import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const feedWorkflow = readFileSync(
  new URL("../.github/workflows/refresh-electron-update-feed.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");

test("main automatically builds the current unsigned macOS and Windows release", () => {
  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:/m);
  assert.match(
    workflow,
    /if: github\.event_name == 'workflow_dispatch' \|\| !startsWith\(github\.event\.head_commit\.message, 'chore\(release\):'\)/,
  );
  assert.match(workflow, /target_platform: \[darwin, win32\]/);
  assert.match(workflow, /id: macos-prod[\s\S]*platform: darwin[\s\S]*arch: arm64/);
  assert.match(workflow, /id: windows-prod[\s\S]*platform: win32[\s\S]*arch: x64/);
  assert.doesNotMatch(workflow, /macos_release_mode|macos-release-signing|developer-id/);
  assert.doesNotMatch(workflow, /APPLE_(?:CERTIFICATE|SIGNING|API_KEY)|WINDOWS_(?:CERTIFICATE|SIGN)/);
  assert.match(workflow, /Require finalized Electron update keys/);
  assert.match(workflow, /ELECTRON_UPDATE_KEYS_FINALIZED/);
});

test("manual dispatch can only dry-run or recover a validated semantic-release tag", () => {
  assert.doesNotMatch(workflow, /noop:/);
  assert.match(
    workflow,
    /- name: Semantic Release dry run\n        if: github\.event_name == 'workflow_dispatch' && inputs\.existing_release_tag == ''[\s\S]*?run: bun run release --dry-run/,
  );
  assert.match(
    workflow,
    /- name: Semantic Release\n        id: semantic\n        if: github\.event_name == 'push'[\s\S]*?run: bun run release/,
  );
  assert.match(workflow, /Refusing to resume .* because it is not an unsigned prerelease/);
  assert.match(workflow, /git merge-base --is-ancestor "\$REQUESTED_RELEASE_TAG\^\{commit\}" origin\/main/);
  assert.doesNotMatch(workflow, /inputs\.noop/);
  assert.match(workflow, /create_draft=true/);
  assert.match(workflow, /latest semantic-release commit/);
  assert.match(workflow, /Recovered semantic-release tag/);
  assert.match(workflow, /scripts\/find-github-release\.sh .*\$REQUESTED_RELEASE_TAG/);
});

test("publication is always a warned prerelease with exact installer and updater assets", () => {
  assert.match(workflow, /gh release create[^\n]*--draft --prerelease --verify-tag/);
  assert.match(workflow, /Refusing to overwrite an existing GitHub Release/);
  assert.match(workflow, /Reusing validated draft prerelease/);
  assert.match(workflow, /> The desktop assets are unsigned, non-notarized manual distributions\./);
  assert.match(workflow, /`-unsigned\.dmg`/);
  assert.match(workflow, /`-unsigned-setup\.exe`/);
  assert.match(workflow, /More info > Run anyway/);
  assert.doesNotMatch(workflow, /because its unsigned distribution warning is missing/);
  assert.match(workflow, /diff -u .*expected-release-assets\.txt.*actual-release-assets\.txt/);
  assert.match(workflow, /Ardor-\$\{RELEASE_TAG\}-mac-arm64-unsigned\.dmg/);
  assert.match(workflow, /Ardor-\$\{RELEASE_TAG\}-mac-arm64\.zip/);
  assert.match(workflow, /Ardor-\$\{RELEASE_TAG\}-windows-x64-unsigned-setup\.exe/);
  assert.match(workflow, /Ardor-\$\{RELEASE_TAG\}-windows-x64-full\.nupkg/);
  assert.match(workflow, /diff -u .*expected-release-assets\.txt.*built-release-assets\.txt/);
  assert.match(workflow, /uploads\.github\.com\/repos\/\$\{\{ github\.repository \}\}\/releases\/\$release_id\/assets/);
  assert.match(workflow, /gh api --method PATCH "repos\/\$\{\{ github\.repository \}\}\/releases\/\$release_id"/);
  assert.match(workflow, /-F tag_name="\$RELEASE_TAG"[\s\S]*?-F draft=false[\s\S]*?-F prerelease=true/);
  assert.match(workflow, /Checkout release workflow[\s\S]*?ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /gh release view "\$RELEASE_TAG"[^\n]*isDraft/);
  assert.doesNotMatch(workflow, /--latest|--prerelease=false/);
});

test("unsigned packages keep OS signing separate from signed updater capabilities", () => {
  assert.match(workflow, /Verify ad-hoc macOS distribution boundary/);
  assert.match(workflow, /Signature=adhoc/);
  assert.match(workflow, /browserWebAuthnKeychainAccessGroup/);
  assert.match(workflow, /config\.autoUpdateEnabled !== true/);
  assert.match(workflow, /readFileSync\(process\.argv\[1\], "utf8"\)/);
  assert.doesNotMatch(workflow, /const config = require\(process\.argv\[1\]\)/);
  assert.match(workflow, /Verify unsigned Windows distribution boundary/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /signature\.Status -ne 'NotSigned'/);
  assert.match(main, /const updatesEnabled = runtimeConfig\?\.autoUpdateEnabled === true/);
  assert.match(main, /createSecureWindowsUpdater\(\{/);
  assert.match(main, /updatesEnabled: false/);
  assert.match(workflow, /Generate signed macOS appcast/);
  assert.match(workflow, /generate_appcast[\s\S]*-o "\$archive_dir\/macos-arm64\.xml"/);
  assert.match(workflow, /sign_update[\s\S]*--disable-signing-warning[\s\S]*macos-arm64\.xml/);
  assert.match(workflow, /sign_update[\s\S]*--verify[\s\S]*macos-arm64\.xml/);
  assert.match(workflow, /Generate signed Windows update manifest/);
  assert.match(workflow, /Publish rolling signed update feeds/);
  assert.doesNotMatch(workflow, /electron-downloads|Publish stable installer download page/);
});

test("CI packages real production unsigned distributions for both platforms", () => {
  assert.match(ciWorkflow, /make-windows:[\s\S]*runs-on: windows-2022/);
  assert.match(ciWorkflow, /Make production ad-hoc macOS shell with a UI fixture/);
  assert.equal(ciWorkflow.match(/http-equiv="Content-Security-Policy"/g)?.length, 2);
  assert.equal(
    ciWorkflow.match(/connect-src https:\/\/console\.ardor\.cloud/g)?.length,
    2,
  );
  assert.match(ciWorkflow, /electron-stage-build\.mjs prod --platform darwin/);
  assert.match(ciWorkflow, /ARDOR_ELECTRON_CHANNEL: prod/);
  assert.doesNotMatch(ciWorkflow, /MACOS_RELEASE_SIGNING_MODE/);
  assert.match(ciWorkflow, /cloud\.ardor\.desktop/);
  assert.match(ciWorkflow, /Signature=adhoc/);
  assert.match(ciWorkflow, /TeamIdentifier=\[A-Z0-9\]\+/);
  assert.match(ciWorkflow, /<key>keychain-access-groups<\/key>/);
  assert.match(ciWorkflow, /"browserWebAuthnKeychainAccessGroup" in config/);
  assert.match(ciWorkflow, /config\.autoUpdateEnabled !== true/);
  assert.match(ciWorkflow, /readFileSync\(process\.argv\[1\], "utf8"\)/);
  assert.doesNotMatch(ciWorkflow, /const config = require\(process\.argv\[1\]\)/);
  assert.match(ciWorkflow, /-unsigned\.dmg/);
  assert.match(ciWorkflow, /mac-\$\{ARDOR_DESKTOP_TARGET_ARCH\}\.zip/);
  assert.match(ciWorkflow, /verify_ad_hoc_app "\$mount_dir\/Ardor\.app" dmg/);
  assert.match(ciWorkflow, /Make and validate production unsigned Windows assets/);
  assert.match(ciWorkflow, /electron-stage-build\.mjs prod --platform win32 --arch x64/);
  assert.match(ciWorkflow, /Get-AuthenticodeSignature/);
  assert.match(ciWorkflow, /Expected unsigned Windows executable/);
  assert.match(ciWorkflow, /autoUpdateEnabled -ne \$true/);
  assert.match(ciWorkflow, /windows-x64-unsigned-setup\.exe/);
  assert.match(ciWorkflow, /windows-x64-full\.nupkg/);
});

test("release assets build native Windows dependencies on the supported runner", () => {
  assert.match(workflow, /id: windows-prod[\s\S]*os: windows-2022/);
  assert.doesNotMatch(workflow, /windows-2025/);
});

test("a failed rolling-feed publication can be recovered only from a verified published release", () => {
  assert.match(feedWorkflow, /^on:\n  workflow_dispatch:/m);
  assert.match(feedWorkflow, /git -C ardor-desktop merge-base --is-ancestor "\$RELEASE_TAG\^\{commit\}" origin\/main/);
  assert.match(feedWorkflow, /test .*\.isDraft.* = "false"/);
  assert.match(feedWorkflow, /test .*\.isPrerelease.* = "true"/);
  assert.match(feedWorkflow, /diff -u .*expected-release-assets\.txt.*actual-release-assets\.txt/);
  assert.match(feedWorkflow, /ELECTRON_UPDATE_KEYS_FINALIZED/);
  assert.match(feedWorkflow, /generate_appcast[\s\S]*-o "\$archive_dir\/macos-arm64\.xml"/);
  assert.match(feedWorkflow, /sign_update[\s\S]*--disable-signing-warning[\s\S]*macos-arm64\.xml/);
  assert.match(feedWorkflow, /sign_update[\s\S]*--verify[\s\S]*macos-arm64\.xml/);
  assert.match(feedWorkflow, /generate-electron-update-metadata\.ts/);
  assert.match(feedWorkflow, /gh release create "\$feed_tag"[\s\S]*--prerelease/);
  assert.match(feedWorkflow, /gh release upload "\$feed_tag"[\s\S]*--clobber/);
  assert.doesNotMatch(feedWorkflow, /electron-downloads|Refresh stable installer download page/);
});
