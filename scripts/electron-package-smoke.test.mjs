import assert from "node:assert/strict";
import { existsSync, lstatSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const packageDirectory = process.env.ARDOR_ELECTRON_PACKAGE_DIR;

if (!packageDirectory) {
  test("Electron package contains the application archive and bundled solutions UI", { skip: true }, () => {});
} else {
  test("Electron package contains the application archive and bundled solutions UI", () => {
    const root = resolve(packageDirectory);
    const archive = resolve(root, "resources", "app.asar");
    const uiIndex = resolve(root, "resources", "dist", "index.html");

    assert.equal(lstatSync(root).isDirectory(), true, `package directory is missing: ${root}`);
    assert.equal(existsSync(archive), true, `Electron archive is missing: ${archive}`);
    assert.ok(statSync(archive).size > 0, `Electron archive is empty: ${archive}`);
    assert.equal(existsSync(uiIndex), true, `bundled UI entrypoint is missing: ${uiIndex}`);
  });
}
