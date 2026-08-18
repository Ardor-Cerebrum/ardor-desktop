import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { extractFile, listPackage } from "@electron/asar";

import { resolveElectronPackageIdentity } from "../electron/package-identity.mjs";

const packageDirectory = process.env.ARDOR_ELECTRON_PACKAGE_DIR;
const outputRoot = resolve("out");

function resolvePackageRoot(packageDirectoryValue) {
  if (!packageDirectoryValue || !existsSync(outputRoot)) {
    return null;
  }

  const expectedRoot = resolve(packageDirectoryValue);
  const packageEntry = readdirSync(outputRoot, { withFileTypes: true }).find(
    (entry) =>
      entry.isDirectory() &&
      resolve(outputRoot, entry.name) === expectedRoot,
  );
  return packageEntry ? resolve(outputRoot, packageEntry.name) : null;
}

function resolveResourcesRoot(packageRoot) {
  const directResourcesRoot = resolve(packageRoot, "resources");
  if (existsSync(directResourcesRoot)) {
    return directResourcesRoot;
  }

  const appBundle = readdirSync(packageRoot, { withFileTypes: true }).find(
    (entry) => entry.isDirectory() && entry.name.endsWith(".app"),
  );
  return appBundle ? resolve(packageRoot, appBundle.name, "Contents", "Resources") : directResourcesRoot;
}

function containsNativeModule(directory) {
  if (!existsSync(directory)) return false;
  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? containsNativeModule(path) : entry.isFile() && entry.name.endsWith(".node");
  });
}

function findFile(directory, name) {
  if (!existsSync(directory)) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

if (!packageDirectory) {
  test("Electron package contains the application archive, terminal runtime, and bundled solutions UI", { skip: true }, () => {});
} else {
  test("Electron package contains the application archive, terminal runtime, and bundled solutions UI", () => {
    const root = resolvePackageRoot(packageDirectory);
    assert.ok(root, `package directory must be a generated child of ${outputRoot}`);
    const resourcesRoot = resolveResourcesRoot(root);
    const archive = resolve(resourcesRoot, "app.asar");
    const uiIndex = resolve(resourcesRoot, "dist", "index.html");
    const runtimeConfig = resolve(resourcesRoot, "runtime-config.json");

    assert.equal(lstatSync(root).isDirectory(), true, `package directory is missing: ${root}`);
    assert.equal(existsSync(archive), true, `Electron archive is missing: ${archive}`);
    assert.ok(statSync(archive).size > 0, `Electron archive is empty: ${archive}`);
    assert.equal(existsSync(uiIndex), true, `bundled UI entrypoint is missing: ${uiIndex}`);
    assert.equal(existsSync(runtimeConfig), true, `desktop runtime config is missing: ${runtimeConfig}`);

    const packagedMetadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
    const expectedIdentity = resolveElectronPackageIdentity(process.env.ARDOR_ELECTRON_CHANNEL ?? "prod");
    assert.equal(packagedMetadata.name, expectedIdentity.name);
    assert.equal(packagedMetadata.productName, expectedIdentity.productName);

    const archiveEntries = new Set(listPackage(archive, { isPack: false }).map((entry) => entry.replace(/^[/\\]+/, "")));
    assert.equal(
      archiveEntries.has("dist/electron/terminal-broker.cjs"),
      true,
      "terminal utility-process entrypoint is missing from app.asar",
    );
    const brokerSource = extractFile(archive, "dist/electron/terminal-broker.cjs").toString("utf8");
    assert.doesNotMatch(
      brokerSource,
      /createRequire\(["']file:\/\/\/(?:home|Users|[A-Za-z]:)/,
      "terminal broker contains an absolute build-machine module path",
    );
    assert.match(
      brokerSource,
      /\brequire\(["']node-pty["']\)/,
      "terminal broker must resolve node-pty from the packaged runtime",
    );
    assert.equal(
      archiveEntries.has("node_modules/node-pty/package.json"),
      true,
      "node-pty JavaScript package is missing from app.asar",
    );
    assert.equal(
      containsNativeModule(resolve(`${archive}.unpacked`, "node_modules", "node-pty")),
      true,
      "node-pty native module was not unpacked beside app.asar",
    );
    if (process.platform === "darwin") {
      const spawnHelper = findFile(resolve(`${archive}.unpacked`, "node_modules", "node-pty"), "spawn-helper");
      assert.ok(spawnHelper, "node-pty spawn-helper was not unpacked beside app.asar");
      assert.notEqual(statSync(spawnHelper).mode & 0o111, 0, "node-pty spawn-helper is not executable");
    }
  });
}
