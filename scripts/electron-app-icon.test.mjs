import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { FuseV1Options, FuseVersion } from "@electron/fuses";

import {
  default as forgeConfig,
  copySparkleFramework,
  resolveMacSigningOptions,
  resolveSparkleInfoPlist,
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

test("isolated update-test builds use the development icon", () => {
  assert.equal(resolveElectronIcon("update-test"), resolveElectronIcon("stage1"));
});

test("local macOS development icons include the Dock safe zone", () => {
  assert.equal(existsSync(resolveElectronIcon("prod").replace(/icon$/, "dock-icon.png")), true);
  assert.equal(existsSync(resolveElectronIcon("stage1").replace(/icon$/, "dock-icon.png")), true);
});

test("unknown Electron channels fail closed", () => {
  assert.throws(() => resolveElectronIcon("preview"), /Unsupported Electron channel/);
});

test("macOS packaging always uses the current ad-hoc contract", () => {
  const options = resolveMacSigningOptions({ platform: "darwin" });
  assert.equal(options.continueOnError, false);
  assert.equal(options.hardenedRuntime, false);
  assert.equal(options.identity, "-");
  assert.equal(options.identityValidation, false);
  assert.deepEqual(options.optionsForFile("/tmp/Ardor.app"), { hardenedRuntime: false });
  assert.deepEqual(options.optionsForFile("/tmp/Electron Framework.framework"), {
    hardenedRuntime: false,
  });
  assert.equal(resolveMacSigningOptions({ platform: "win32" }), undefined);
});

test("Sparkle packaging requires signed remote feeds and permits loopback smoke feeds", () => {
  const publicKey = Buffer.alloc(32, 7).toString("base64");
  assert.equal(
    resolveSparkleInfoPlist({ feedUrl: "https://updates.ardor.cloud/appcast.xml", publicKey })
      .SURequireSignedFeed,
    true,
  );
  const loopback = resolveSparkleInfoPlist({
    feedUrl: "http://127.0.0.1:18765/appcast.xml",
    publicKey,
  });
  assert.equal(loopback.SURequireSignedFeed, false);
  assert.equal(loopback.NSAppTransportSecurity.NSAllowsLocalNetworking, true);
  assert.throws(
    () => resolveSparkleInfoPlist({ feedUrl: "http://updates.ardor.cloud/appcast.xml", publicKey }),
    /HTTPS or loopback HTTP/,
  );
  assert.throws(
    () => resolveSparkleInfoPlist({ feedUrl: "https://updates.ardor.cloud/appcast.xml", publicKey: "bad" }),
    /Ed25519 public key/,
  );
});

test("Sparkle framework copying preserves relative framework symlinks", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "ardor-sparkle-copy-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const frameworkSource = resolve(root, "source", "Sparkle.framework");
  const versionDirectory = resolve(frameworkSource, "Versions", "B");
  const bridgeSource = resolve(root, "sparkle_bridge.node");
  const buildPath = resolve(root, "Ardor.app", "Contents", "Resources", "app");
  await mkdir(versionDirectory, { recursive: true });
  await mkdir(buildPath, { recursive: true });
  await writeFile(resolve(versionDirectory, "Sparkle"), "bridge");
  await writeFile(bridgeSource, "native bridge");
  await symlink("B", resolve(frameworkSource, "Versions", "Current"));
  await symlink("Versions/Current/Sparkle", resolve(frameworkSource, "Sparkle"));

  await copySparkleFramework(buildPath, "darwin", {
    bridgeSource,
    enabled: true,
    frameworkSource,
  });

  assert.equal(
    await readlink(resolve(root, "Ardor.app", "Contents", "Frameworks", "Sparkle.framework", "Sparkle")),
    join("Versions", "Current", "Sparkle"),
  );
});

test("Electron packaging excludes generated outputs, omits updater archives, and hardens Electron fuses", () => {
  assert.equal(typeof forgeConfig.packagerConfig.ignore, "function");
  assert.match(forgeConfig.packagerConfig.asar.unpack, /node-pty\/\*\*\/spawn-helper/);
  assert.equal(forgeConfig.packagerConfig.beforeAsar.length, 1);
  assert.equal(forgeConfig.makers.some((maker) => maker.name === "@electron-forge/maker-zip"), false);
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
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot], false);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.GrantFileProtocolExtraPrivileges], false);
  assert.equal(fusesPlugin.fusesConfig[FuseV1Options.WasmTrapHandlers], true);
  assert.equal(fusesPlugin.fusesConfig.strictlyRequireAllFuses, true);
  assert.equal(shouldIgnorePackagedPath("/out/ardor-win32-x64/resources/app.asar"), true);
  assert.equal(shouldIgnorePackagedPath("/dist/electron/main.cjs"), false);
  assert.equal(shouldIgnorePackagedPath("/electron/main.ts"), false);
});
