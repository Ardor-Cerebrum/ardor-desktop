import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  default as forgeConfig,
  resolveMacSigningOptions,
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

test("unknown Electron channels fail closed", () => {
  assert.throws(() => resolveElectronIcon("preview"), /Unsupported Electron channel/);
});

test("macOS signing is explicit and supports the CI ad-hoc identity", () => {
  assert.equal(resolveMacSigningOptions(""), undefined);
  assert.deepEqual(resolveMacSigningOptions("-"), {
    identity: "-",
    identityValidation: false,
  });
  assert.deepEqual(resolveMacSigningOptions("Developer ID Application: Ardor"), {
    identity: "Developer ID Application: Ardor",
    identityValidation: true,
  });
});

test("Electron packaging excludes generated outputs and keeps runtime files", () => {
  assert.equal(typeof forgeConfig.packagerConfig.ignore, "function");
  const squirrelMaker = forgeConfig.makers.find((maker) => maker.name === "@electron-forge/maker-squirrel");
  assert.equal(squirrelMaker.config.setupIcon, `${resolveElectronIcon("prod")}.ico`);
  assert.equal(shouldIgnorePackagedPath("/out/ardor-win32-x64/resources/app.asar"), true);
  assert.equal(shouldIgnorePackagedPath("/dist/electron/main.cjs"), false);
  assert.equal(shouldIgnorePackagedPath("/electron/main.ts"), false);
});
