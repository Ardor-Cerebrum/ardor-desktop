import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readElectronChannelEnv,
  resolveElectronAutoUpdateEnabled,
  resolveElectronUiEnvironment,
  validateBuiltUiConfig,
} from "./electron-stage-build.mjs";

test("enables the updater only for a macOS package with complete Sparkle configuration", () => {
  const sparkle = {
    ARDOR_SPARKLE_FEED_URL: "https://releases.ardor.cloud/appcast.xml",
    ARDOR_SPARKLE_PUBLIC_KEY: "public-key",
  };

  assert.equal(resolveElectronAutoUpdateEnabled(sparkle, "darwin"), true);
  assert.equal(resolveElectronAutoUpdateEnabled(sparkle, "win32"), false);
  assert.equal(resolveElectronAutoUpdateEnabled({ ...sparkle, ARDOR_SPARKLE_PUBLIC_KEY: "" }, "darwin"), false);
  assert.equal(resolveElectronAutoUpdateEnabled({}, "darwin"), false);
});

test("builds the stage UI for the Windows Electron target", () => {
  const environment = resolveElectronUiEnvironment({
    channel: "stage1",
    fileEnv: { VITE_API_URL: "https://stage1.dev.ardor.cloud" },
    processEnv: { ARDOR_DESKTOP_TARGET_PLATFORM: "linux" },
    targetPlatform: "win32",
    uiDir: "/tmp/solutions-ui",
  });

  assert.equal(environment.ARDOR_DESKTOP_TARGET_PLATFORM, "win32");
  assert.equal(environment.ARDOR_SOLUTIONS_UI_DIR, "/tmp/solutions-ui");
  assert.equal(environment.VITE_DESKTOP_BUILD_CHANNEL, "stage1");
});

test("accepts a stage UI bundle with the configured API and Auth0 values", () => {
  assert.doesNotThrow(() =>
    validateBuiltUiConfig(
      "https://stage1.dev.ardor.cloud auth-dev.ardor.cloud NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
      {
        apiUrl: "https://stage1.dev.ardor.cloud",
        auth0Domain: "auth-dev.ardor.cloud",
        auth0ClientId: "NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
      },
    ),
  );
});

test("rejects the test placeholder UI bundle before packaging", () => {
  assert.throws(
    () =>
      validateBuiltUiConfig("https://api.test auth.test client-id", {
        apiUrl: "https://stage1.dev.ardor.cloud",
        auth0Domain: "auth-dev.ardor.cloud",
        auth0ClientId: "NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
      }),
    /does not contain the expected stage configuration/,
  );
});

test("allows production package jobs to use exported env without ignored prod.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-electron-stage-"));
  try {
    const fileEnv = await readElectronChannelEnv(join(root, "prod.env"), {
      channel: "prod",
      processEnv: { ARDOR_SKIP_UI_BUILD: "true" },
    });
    assert.deepEqual(fileEnv, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps missing stage env files as a hard failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-electron-stage-"));
  try {
    await assert.rejects(
      readElectronChannelEnv(join(root, "stage1.env"), {
        channel: "stage1",
        processEnv: { ARDOR_SKIP_UI_BUILD: "true" },
      }),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects bundle validation when production env was not exported", () => {
  assert.throws(
    () =>
      validateBuiltUiConfig("https://prod.ardor.cloud auth.ardor.cloud prod-client-id", {
        apiUrl: undefined,
        auth0Domain: "auth.ardor.cloud",
        auth0ClientId: "prod-client-id",
      }),
    /missing expected values: apiUrl/,
  );
});
