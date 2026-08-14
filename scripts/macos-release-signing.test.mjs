import assert from "node:assert/strict";
import test from "node:test";

import {
  MACOS_RELEASE_SIGNING_MODE,
  resolveDesktopReleaseTargets,
  resolveProductionMacSigningMode,
  resolveWorkflowMacSigningMode,
} from "./macos-release-signing.mjs";

const packageCredentials = {
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Ardor",
  APPLE_TEAM_ID: "Q6L2SF6YDW",
  APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
  APPLE_API_KEY_ID: "TEST",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
};

const workflowCredentials = {
  APPLE_CERTIFICATE_P12_BASE64: "certificate",
  APPLE_CERTIFICATE_PASSWORD: "certificate-password",
  APPLE_KEYCHAIN_PASSWORD: "keychain-password",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Ardor",
  APPLE_API_KEY_P8_BASE64: "api-key",
  APPLE_API_KEY_ID: "TEST",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
};

test("production macOS packaging selects only complete Developer ID credentials or ad-hoc", () => {
  assert.equal(
    resolveProductionMacSigningMode({ environment: {}, platform: "darwin" }),
    MACOS_RELEASE_SIGNING_MODE.AD_HOC,
  );
  assert.equal(
    resolveProductionMacSigningMode({
      environment: { APPLE_SIGNING_IDENTITY: "-" },
      platform: "darwin",
    }),
    MACOS_RELEASE_SIGNING_MODE.AD_HOC,
  );
  assert.equal(
    resolveProductionMacSigningMode({ environment: packageCredentials, platform: "darwin" }),
    MACOS_RELEASE_SIGNING_MODE.DEVELOPER_ID,
  );

  for (const missingName of Object.keys(packageCredentials)) {
    const environment = { ...packageCredentials, [missingName]: "" };
    assert.throws(
      () => resolveProductionMacSigningMode({ environment, platform: "darwin" }),
      new RegExp(`Incomplete production macOS signing configuration.*${missingName}`),
    );
  }
});

test("release workflow credentials fail closed when only part of the tuple is configured", () => {
  assert.equal(resolveWorkflowMacSigningMode({}), MACOS_RELEASE_SIGNING_MODE.AD_HOC);
  assert.equal(
    resolveWorkflowMacSigningMode(workflowCredentials),
    MACOS_RELEASE_SIGNING_MODE.DEVELOPER_ID,
  );

  for (const missingName of Object.keys(workflowCredentials)) {
    const environment = { ...workflowCredentials, [missingName]: "" };
    assert.throws(
      () => resolveWorkflowMacSigningMode(environment),
      new RegExp(`Incomplete production macOS signing configuration.*${missingName}`),
    );
  }
});

test("ad-hoc releases target manual macOS only while Developer ID releases keep all platforms", () => {
  const adHocTargets = resolveDesktopReleaseTargets(MACOS_RELEASE_SIGNING_MODE.AD_HOC);
  assert.deepEqual(adHocTargets.uiPlatforms, ["darwin"]);
  assert.deepEqual(adHocTargets.assetMatrix.include.map(({ platform }) => platform), ["darwin"]);
  assert.match(adHocTargets.assetMatrix.include[0].label, /ad-hoc/);

  const signedTargets = resolveDesktopReleaseTargets(MACOS_RELEASE_SIGNING_MODE.DEVELOPER_ID);
  assert.deepEqual(signedTargets.uiPlatforms, ["darwin", "win32"]);
  assert.deepEqual(signedTargets.assetMatrix.include.map(({ platform }) => platform), ["darwin", "win32"]);
  assert.throws(() => resolveDesktopReleaseTargets("unsigned"), /Unsupported macOS release signing mode/);
});
