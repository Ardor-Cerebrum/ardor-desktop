import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { FuseV1Options, FuseVersion } from "@electron/fuses";

import {
  default as forgeConfig,
  resolveMacNotarizeOptions,
  resolveMacSigningOptions,
  resolveWindowsSigningOptions,
  shouldIgnorePackagedPath,
} from "../electron/forge.config.mjs";
import { resolveElectronIcon } from "./electron-app-icon.mjs";

test("production Electron builds use the plain Ardor icon", () => {
  const iconRoot = resolveElectronIcon("prod");

  assert.match(iconRoot, /assets[\\/]icons[\\/]prod[\\/]icon$/);
  assert.equal(existsSync(`${iconRoot}.ico`), true);
  assert.equal(existsSync(`${iconRoot}.icns`), true);
});

test("stage Electron builds use the Ardor DEV icon", () => {
  const iconRoot = resolveElectronIcon("stage1");

  assert.match(iconRoot, /assets[\\/]icons[\\/]stage1[\\/]icon$/);
  assert.equal(existsSync(`${iconRoot}.ico`), true);
  assert.equal(existsSync(`${iconRoot}.icns`), true);
});

test("local macOS development icons include the Dock safe zone", () => {
  assert.equal(existsSync(resolveElectronIcon("prod").replace(/icon$/, "dock-icon.png")), true);
  assert.equal(existsSync(resolveElectronIcon("stage1").replace(/icon$/, "dock-icon.png")), true);
});

test("unknown Electron channels fail closed", () => {
  assert.throws(() => resolveElectronIcon("preview"), /Unsupported Electron channel/);
});

test("macOS signing is explicit, and production rejects missing or ad-hoc identities", () => {
  assert.equal(resolveMacSigningOptions({ identity: "", isProduction: false, platform: "darwin" }), undefined);
  assert.deepEqual(resolveMacSigningOptions({ identity: "-", isProduction: false, platform: "darwin" }), {
    identity: "-",
    identityValidation: false,
  });
  assert.deepEqual(
    resolveMacSigningOptions({
      environment: { APPLE_KEYCHAIN_PATH: "/tmp/ardor.keychain-db" },
      identity: "Developer ID Application: Ardor",
      isProduction: true,
      platform: "darwin",
    }),
    {
      identity: "Developer ID Application: Ardor",
      identityValidation: true,
      keychain: "/tmp/ardor.keychain-db",
    },
  );
  assert.throws(
    () => resolveMacSigningOptions({ identity: "", isProduction: true, platform: "darwin" }),
    /APPLE_SIGNING_IDENTITY/,
  );
  assert.throws(
    () => resolveMacSigningOptions({ identity: "-", isProduction: true, platform: "darwin" }),
    /Ad-hoc macOS signing is not allowed/,
  );
  assert.equal(resolveMacSigningOptions({ identity: "-", isProduction: true, platform: "win32" }), undefined);
});

test("production macOS notarization requires App Store Connect API credentials", () => {
  const environment = {
    APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
    APPLE_API_KEY_ID: "TEST",
    APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
  };
  assert.deepEqual(resolveMacNotarizeOptions({ environment, isProduction: true, platform: "darwin" }), {
    appleApiKey: environment.APPLE_API_KEY,
    appleApiKeyId: environment.APPLE_API_KEY_ID,
    appleApiIssuer: environment.APPLE_API_ISSUER,
  });
  assert.equal(resolveMacNotarizeOptions({ environment: {}, isProduction: false, platform: "darwin" }), undefined);
  assert.throws(
    () => resolveMacNotarizeOptions({ environment: {}, isProduction: true, platform: "darwin" }),
    /APPLE_API_KEY/,
  );
});

test("production Windows builds require a PFX or custom signing provider", () => {
  assert.equal(resolveWindowsSigningOptions({ environment: {}, isProduction: false, platform: "win32" }), undefined);
  assert.throws(
    () => resolveWindowsSigningOptions({ environment: {}, isProduction: true, platform: "win32" }),
    /Windows code signing configuration is required/,
  );
  assert.deepEqual(
    resolveWindowsSigningOptions({
      environment: {
        WINDOWS_CERTIFICATE_FILE: "C:\\ardor.pfx",
        WINDOWS_CERTIFICATE_PASSWORD: "password",
      },
      isProduction: true,
      platform: "win32",
    }),
    {
      certificateFile: "C:\\ardor.pfx",
      certificatePassword: "password",
      description: "Ardor desktop application",
      hashes: ["sha256"],
      timestampServer: "http://timestamp.digicert.com",
      website: "https://ardor.cloud",
    },
  );
});

test("Electron packaging excludes generated outputs, signs makers, and hardens Electron fuses", () => {
  assert.equal(typeof forgeConfig.packagerConfig.ignore, "function");
  const squirrelMaker = forgeConfig.makers.find((maker) => maker.name === "@electron-forge/maker-squirrel");
  const activeChannel = process.env.ARDOR_ELECTRON_CHANNEL ?? "prod";
  assert.equal(squirrelMaker.config.setupIcon, `${resolveElectronIcon(activeChannel)}.ico`);
  const fusesPlugin = forgeConfig.plugins.find((plugin) => plugin.name === "fuses");
  assert.equal(fusesPlugin.fusesConfig.version, FuseVersion.V1);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.RunAsNode], false);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.EnableCookieEncryption], true);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.OnlyLoadAppFromAsar], true);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot], true);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.GrantFileProtocolExtraPrivileges], false);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.WasmTrapHandlers], true);
  assert.equal(fusesPlugin.fusesConfig.strictlyRequireAllFuses, true);
  assert.equal(shouldIgnorePackagedPath("/out/ardor-win32-x64/resources/app.asar"), true);
  assert.equal(shouldIgnorePackagedPath("/dist/electron/main.cjs"), false);
  assert.equal(shouldIgnorePackagedPath("/electron/main.ts"), false);
});
