import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { collectElectronReleaseAssets, resolveReleaseTarget } from "./electron-release-assets.mjs";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "ardor-release-assets-"));
  const makeDirectory = join(root, "make");
  const destinationDirectory = join(root, "release");
  await mkdir(makeDirectory, { recursive: true });
  try {
    await run({ root, makeDirectory, destinationDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const options = (platform, makeDirectory, destinationDirectory, arch) => ({
  platform,
  arch,
  releaseTag: "v0.4.4",
  packageVersion: "0.4.4",
  makeDirectory,
  destinationDirectory,
});

test("collects one macOS ZIP and DMG with stable release names", async () => {
  await withFixture(async ({ makeDirectory, destinationDirectory }) => {
    await mkdir(join(makeDirectory, "zip", "darwin", "arm64"), { recursive: true });
    await writeFile(join(makeDirectory, "zip", "darwin", "arm64", "Ardor-darwin-arm64-0.4.4.zip"), "zip");
    await writeFile(join(makeDirectory, "Ardor-0.4.4-arm64.dmg"), "dmg");

    const assets = await collectElectronReleaseAssets(options("darwin", makeDirectory, destinationDirectory, "arm64"));
    assert.deepEqual(assets.map((asset) => asset.slice(destinationDirectory.length + 1)).sort(), [
      "Ardor-v0.4.4-mac-arm64.dmg",
      "Ardor-v0.4.4-mac-arm64.zip",
    ]);
    assert.equal(await readFile(join(destinationDirectory, "Ardor-v0.4.4-mac-arm64.zip"), "utf8"), "zip");
  });
});

test("rejects unreleased macOS architectures instead of publishing dead updater feeds", () => {
  assert.throws(
    () => resolveReleaseTarget({ platform: "darwin", arch: "x64" }),
    /Unsupported macOS release architecture/,
  );
});

test("rejects missing or duplicate macOS artifacts", async () => {
  await withFixture(async ({ makeDirectory, destinationDirectory }) => {
    await writeFile(join(makeDirectory, "one.zip"), "zip");
    await writeFile(join(makeDirectory, "two.zip"), "zip");
    await writeFile(join(makeDirectory, "app.dmg"), "dmg");
    await assert.rejects(
      collectElectronReleaseAssets(options("darwin", makeDirectory, destinationDirectory, "arm64")),
      /exactly one macOS ZIP asset/,
    );
  });
});

test("collects and verifies a complete Squirrel.Windows release", async () => {
  await withFixture(async ({ makeDirectory, destinationDirectory }) => {
    const installer = join(makeDirectory, "Ardor Setup.exe");
    const packageFile = join(makeDirectory, "ardor-0.4.4-full.nupkg");
    const packageContents = Buffer.from("squirrel package");
    await writeFile(installer, "installer");
    await writeFile(packageFile, packageContents);
    const hash = createHash("sha1").update(packageContents).digest("hex").toUpperCase();
    await writeFile(join(makeDirectory, "RELEASES"), `${hash} ${basename(packageFile)} ${packageContents.length}\n`);

    const assets = await collectElectronReleaseAssets(options("win32", makeDirectory, destinationDirectory, "x64"));
    assert.deepEqual(assets.map((asset) => asset.slice(destinationDirectory.length + 1)).sort(), [
      "Ardor-v0.4.4-win32-x64-setup.exe",
      "RELEASES",
      "ardor-0.4.4-full.nupkg",
    ]);
    assert.equal(existsSync(installer), true);
  });
});

test("rejects unreleased Windows architectures", () => {
  assert.throws(
    () => resolveReleaseTarget({ platform: "win32", arch: "arm64" }),
    /Unsupported Windows release architecture/,
  );
});

test("rejects a Squirrel manifest with a mismatched package hash", async () => {
  await withFixture(async ({ makeDirectory, destinationDirectory }) => {
    await writeFile(join(makeDirectory, "Ardor Setup.exe"), "installer");
    await writeFile(join(makeDirectory, "ardor-0.4.4-full.nupkg"), "package");
    await writeFile(join(makeDirectory, "RELEASES"), "000000 ardor-0.4.4-full.nupkg 7\n");
    await assert.rejects(
      collectElectronReleaseAssets(options("win32", makeDirectory, destinationDirectory)),
      /hash does not match/,
    );
  });
});

test("rejects release tags that do not match package.json", async () => {
  await withFixture(async ({ makeDirectory, destinationDirectory }) => {
    await assert.rejects(
      collectElectronReleaseAssets({
        ...options("darwin", makeDirectory, destinationDirectory),
        releaseTag: "v0.4.5",
      }),
      /does not match package version/,
    );
  });
});
