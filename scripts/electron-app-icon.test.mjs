import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { default as forgeConfig, shouldIgnorePackagedPath } from "../electron/forge.config.mjs";
import { resolveElectronIcon } from "./electron-app-icon.mjs";

test("production Electron builds use the plain Ardor icon", () => {
  const iconRoot = resolveElectronIcon("prod");

  assert.match(iconRoot, /src-tauri[\\/]icons[\\/]icon$/);
  assert.equal(existsSync(`${iconRoot}.ico`), true);
  assert.equal(existsSync(`${iconRoot}.icns`), true);
});

test("stage Electron builds use the Ardor DEV icon", () => {
  const iconRoot = resolveElectronIcon("stage1");

  assert.match(iconRoot, /src-tauri[\\/]icons-stage[\\/]icon$/);
  assert.equal(existsSync(`${iconRoot}.ico`), true);
  assert.equal(existsSync(`${iconRoot}.icns`), true);
});

test("unknown Electron channels fail closed", () => {
  assert.throws(() => resolveElectronIcon("preview"), /Unsupported Electron channel/);
});

test("Electron packaging excludes native build outputs and keeps runtime files", () => {
  assert.equal(typeof forgeConfig.packagerConfig.ignore, "function");
  const squirrelMaker = forgeConfig.makers.find((maker) => maker.name === "@electron-forge/maker-squirrel");
  assert.equal(squirrelMaker.config.setupIcon, `${resolveElectronIcon("prod")}.ico`);
  assert.equal(shouldIgnorePackagedPath("/src-tauri/target/debug/app"), true);
  assert.equal(shouldIgnorePackagedPath("C:\\repo\\src-tauri\\cef-cache\\150.0.10"), true);
  assert.equal(shouldIgnorePackagedPath("/src-tauri/cef-cache/150.0.10"), true);
  assert.equal(shouldIgnorePackagedPath("/out/ardor-win32-x64/resources/app.asar"), true);
  assert.equal(shouldIgnorePackagedPath("/dist/electron/main.cjs"), false);
  assert.equal(shouldIgnorePackagedPath("/electron/main.ts"), false);
});
