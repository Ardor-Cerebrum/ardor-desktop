import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readElectronChannelEnv,
  resolveElectronAutoUpdateEnabled,
  resolveElectronUiEnvironment,
  resolveWindowsUpdateRuntimeConfig,
  stageCerebrumBinary,
  validateBuiltUiConfig,
} from "./electron-stage-build.mjs";

test("stages the selected Cerebrum sidecar as a package resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-cerebrum-stage-"));
  try {
    const source = join(root, "source-cerebrum");
    await writeFile(source, "binary");
    const destination = await stageCerebrumBinary({
      arch: process.arch,
      platform: "darwin",
      root,
      source,
    });
    assert.equal(await readFile(destination, "utf8"), "binary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enables each updater only with its complete platform configuration", () => {
  const sparkle = {
    ARDOR_SPARKLE_FEED_URL: "https://releases.ardor.cloud/appcast.xml",
    ARDOR_SPARKLE_PUBLIC_KEY: "public-key",
  };

  assert.equal(resolveElectronAutoUpdateEnabled(sparkle, "darwin"), true);
  assert.equal(resolveElectronAutoUpdateEnabled(sparkle, "win32"), false);
  assert.equal(resolveElectronAutoUpdateEnabled({ ...sparkle, ARDOR_SPARKLE_PUBLIC_KEY: "" }, "darwin"), false);
  assert.equal(resolveElectronAutoUpdateEnabled({}, "darwin"), false);

  const windows = {
    ARDOR_WINDOWS_UPDATE_FEED_URL: "https://updates.ardor.cloud/windows-x64.json",
    ARDOR_WINDOWS_UPDATE_PUBLIC_KEY: "public-key",
  };
  assert.equal(resolveElectronAutoUpdateEnabled(windows, "win32"), true);
  assert.equal(resolveElectronAutoUpdateEnabled(windows, "darwin"), false);
  assert.equal(
    resolveElectronAutoUpdateEnabled({ ...windows, ARDOR_WINDOWS_UPDATE_PUBLIC_KEY: "" }, "win32"),
    false,
  );
  assert.equal(
    resolveWindowsUpdateRuntimeConfig({ ...windows, ARDOR_WINDOWS_UPDATE_PUBLIC_KEY: "" }, "win32"),
    undefined,
  );
  assert.deepEqual(resolveWindowsUpdateRuntimeConfig(windows, "win32"), {
    windowsUpdateFeedUrl: windows.ARDOR_WINDOWS_UPDATE_FEED_URL,
    windowsUpdatePublicKey: windows.ARDOR_WINDOWS_UPDATE_PUBLIC_KEY,
  });
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
      '<meta http-equiv="Content-Security-Policy" content="connect-src \'self\' https://stage1.dev.ardor.cloud"> '
        + "https://stage1.dev.ardor.cloud auth-dev.ardor.cloud NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
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

test("rejects a desktop UI bundle whose CSP omits the configured API origin", () => {
  assert.throws(
    () =>
      validateBuiltUiConfig(
        '<meta http-equiv="Content-Security-Policy" content="connect-src \'self\' https://auth-dev.ardor.cloud"> '
          + "https://stage1.dev.ardor.cloud auth-dev.ardor.cloud NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
        {
          apiUrl: "https://stage1.dev.ardor.cloud",
          auth0Domain: "auth-dev.ardor.cloud",
          auth0ClientId: "NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
        },
      ),
    /desktop CSP does not allow the configured API origin/,
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
