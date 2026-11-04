import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveElectronPackageIdentity, resolveElectronPackageMetadata, stampElectronPackageIdentity } from "./package-identity.mjs";

test("resolves isolated package identities for Stage, update smoke tests, and production", () => {
  assert.deepEqual(resolveElectronPackageIdentity("stage1"), {
    bundleId: "cloud.ardor.desktop.stage1",
    name: "ardor-desktop-stage1",
    productName: "Ardor Dev",
  });
  assert.deepEqual(resolveElectronPackageIdentity("prod"), {
    bundleId: "cloud.ardor.desktop",
    name: "ardor-desktop",
    productName: "Ardor",
  });
  assert.deepEqual(resolveElectronPackageIdentity("update-test"), {
    bundleId: "cloud.ardor.desktop.update-test",
    name: "ardor-desktop-update-test",
    productName: "Ardor Update Test",
  });
  assert.throws(() => resolveElectronPackageIdentity("preview"), /Unsupported Electron channel/);
});

test("stamps only the packaged copy of package metadata", async () => {
  const buildPath = await mkdtemp(join(tmpdir(), "ardor-package-identity-"));
  try {
    const packagePath = join(buildPath, "package.json");
    await writeFile(
      packagePath,
      `${JSON.stringify({ name: "@ardor/desktop", version: "0.5.0", main: "dist/electron/main.cjs" })}\n`,
      "utf8",
    );

    await stampElectronPackageIdentity(buildPath, "stage1");

    assert.deepEqual(JSON.parse(await readFile(packagePath, "utf8")), {
      name: "ardor-desktop-stage1",
      productName: "Ardor Dev",
      version: "0.5.0",
      main: "dist/electron/main.cjs",
    });
  } finally {
    await rm(buildPath, { recursive: true, force: true });
  }
});

test("uses the build version for both maker metadata and packaged app metadata", async () => {
  const original = { name: "@ardor/desktop", version: "0.8.18", main: "dist/electron/main.cjs" };
  const options = { channel: "stage1", version: "0.8.19" };
  const expected = { ...original, name: "ardor-desktop-stage1", productName: "Ardor Dev", version: "0.8.19" };
  assert.deepEqual(resolveElectronPackageMetadata(original, options), expected);
  assert.equal(original.version, "0.8.18");
  const buildPath = await mkdtemp(join(tmpdir(), "ardor-package-version-"));
  try {
    await writeFile(join(buildPath, "package.json"), JSON.stringify(original));
    await stampElectronPackageIdentity(buildPath, "stage1", { version: options.version });
    assert.deepEqual(JSON.parse(await readFile(join(buildPath, "package.json"), "utf8")), expected);
  } finally {
    await rm(buildPath, { recursive: true, force: true });
  }
});
