import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
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

const options = (platform, workspaceRoot, makeDirectory, destinationDirectory, arch) => ({
  workspaceRoot,
  platform,
  arch,
  releaseTag: "v0.4.4",
  packageVersion: "0.4.4",
  makeDirectory,
  destinationDirectory,
});

test("publishes the unsigned macOS installer and signed-update archive", async () => {
  await withFixture(async ({ root, makeDirectory, destinationDirectory }) => {
    await mkdir(join(makeDirectory, "zip", "darwin", "arm64"), { recursive: true });
    await writeFile(join(makeDirectory, "zip", "darwin", "arm64", "Ardor-darwin-arm64-0.4.4.zip"), "zip");
    await writeFile(join(makeDirectory, "Ardor-0.4.4-arm64.dmg"), "dmg");

    const assets = await collectElectronReleaseAssets(options("darwin", root, makeDirectory, destinationDirectory, "arm64"));
    const resolvedDestination = await realpath(destinationDirectory);
    assert.deepEqual(assets.map((asset) => relative(resolvedDestination, asset)), [
      "Ardor-v0.4.4-mac-arm64-unsigned.dmg",
      "Ardor-v0.4.4-mac-arm64.zip",
    ]);
  });
});

test("rejects unreleased macOS architectures instead of publishing dead updater feeds", () => {
  assert.throws(
    () => resolveReleaseTarget({ platform: "darwin", arch: "x64" }),
    /Unsupported macOS release architecture/,
  );
});

test("rejects missing or duplicate macOS artifacts", async () => {
  await withFixture(async ({ root, makeDirectory, destinationDirectory }) => {
    await writeFile(join(makeDirectory, "one.dmg"), "dmg");
    await writeFile(join(makeDirectory, "two.dmg"), "dmg");
    await assert.rejects(
      collectElectronReleaseAssets(options("darwin", root, makeDirectory, destinationDirectory, "arm64")),
      /exactly one macOS DMG asset/,
    );
  });
});

test("publishes the unsigned Windows installer and verified Squirrel package", async () => {
  await withFixture(async ({ root, makeDirectory, destinationDirectory }) => {
    const installer = join(makeDirectory, "Ardor Setup.exe");
    const packageFile = join(makeDirectory, "ardor-0.4.4-full.nupkg");
    const packageContents = Buffer.from("squirrel package");
    await writeFile(installer, "installer");
    await writeFile(packageFile, packageContents);
    const hash = createHash("sha1").update(packageContents).digest("hex").toUpperCase();
    await writeFile(join(makeDirectory, "RELEASES"), `${hash} ${basename(packageFile)} ${packageContents.length}\n`);

    const assets = await collectElectronReleaseAssets(options("win32", root, makeDirectory, destinationDirectory, "x64"));
    const resolvedDestination = await realpath(destinationDirectory);
    assert.deepEqual(assets.map((asset) => relative(resolvedDestination, asset)), [
      "Ardor-v0.4.4-windows-x64-unsigned-setup.exe",
      "Ardor-v0.4.4-windows-x64-full.nupkg",
    ]);
    assert.equal(existsSync(installer), true);
    assert.equal(existsSync(join(destinationDirectory, "RELEASES")), false);
    assert.equal(existsSync(join(destinationDirectory, basename(packageFile))), false);
  });
});

test("rejects unreleased Windows architectures", () => {
  assert.throws(
    () => resolveReleaseTarget({ platform: "win32", arch: "arm64" }),
    /Unsupported Windows release architecture/,
  );
});

test("rejects a Squirrel manifest with a mismatched package hash", async () => {
  await withFixture(async ({ root, makeDirectory, destinationDirectory }) => {
    await writeFile(join(makeDirectory, "Ardor Setup.exe"), "installer");
    await writeFile(join(makeDirectory, "ardor-0.4.4-full.nupkg"), "package");
    await writeFile(join(makeDirectory, "RELEASES"), "000000 ardor-0.4.4-full.nupkg 7\n");
    await assert.rejects(
      collectElectronReleaseAssets(options("win32", root, makeDirectory, destinationDirectory)),
      /hash does not match/,
    );
  });
});

test("rejects release tags that do not match package.json", async () => {
  await withFixture(async ({ root, makeDirectory, destinationDirectory }) => {
    await assert.rejects(
      collectElectronReleaseAssets({
        ...options("darwin", root, makeDirectory, destinationDirectory),
        releaseTag: "v0.4.5",
      }),
      /does not match package version/,
    );
  });
});

test("rejects release paths outside the workspace", async () => {
  await withFixture(async ({ root, makeDirectory }) => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "ardor-release-assets-outside-"));
    try {
      await assert.rejects(
        collectElectronReleaseAssets(options("darwin", root, makeDirectory, join(outsideRoot, "release"), "arm64")),
        /must be inside the release workspace/,
      );
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

test("does not follow release artifact symlinks outside the workspace", async () => {
  await withFixture(async ({ root, makeDirectory, destinationDirectory }) => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "ardor-release-assets-outside-"));
    try {
      const outsideDmg = join(outsideRoot, "outside.dmg");
      await writeFile(outsideDmg, "outside");
      await symlink(outsideDmg, join(makeDirectory, "outside.dmg"));
      await assert.rejects(
        collectElectronReleaseAssets(options("darwin", root, makeDirectory, destinationDirectory, "arm64")),
        /exactly one macOS DMG asset/,
      );
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
