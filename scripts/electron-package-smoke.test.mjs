import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const packageDirectory = process.env.ARDOR_ELECTRON_PACKAGE_DIR;
const outputRoot = resolve("out");

function resolvePackageRoot(packageDirectoryValue) {
  if (!packageDirectoryValue || !existsSync(outputRoot)) {
    return null;
  }

  const packageEntry = readdirSync(outputRoot, { withFileTypes: true }).find(
    (entry) =>
      entry.isDirectory() &&
      [`out/${entry.name}`, `out/${entry.name}/`].includes(packageDirectoryValue),
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

if (!packageDirectory) {
  test("Electron package contains the application archive and bundled solutions UI", { skip: true }, () => {});
} else {
  test("Electron package contains the application archive and bundled solutions UI", () => {
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
  });
}
