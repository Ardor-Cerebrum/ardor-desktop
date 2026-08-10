import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDmgArtifact, MakerArdorDMG } from "./electron-dmg-maker.mjs";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "ardor-dmg-test-"));
  const packageDirectory = join(root, "package");
  const makeDirectory = join(root, "make");
  await mkdir(join(packageDirectory, "Ardor.app"), { recursive: true });

  try {
    await run({ root, packageDirectory, makeDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("creates a compressed DMG from a staged app and Applications link", async () => {
  await withFixture(async ({ packageDirectory, makeDirectory }) => {
    const calls = [];
    let stagingDirectory;
    const runCommand = async (command, args) => {
      calls.push([command, args]);
      if (command === "/usr/bin/hdiutil") {
        stagingDirectory = args[args.indexOf("-srcfolder") + 1];
        const artifactPath = args[args.indexOf("-o") + 1];
        assert.equal(
          lstatSync(join(stagingDirectory, "Applications")).isSymbolicLink(),
          true,
        );
        await writeFile(artifactPath, "test dmg");
      }
    };

    const artifactPath = await createDmgArtifact(
      {
        dir: packageDirectory,
        makeDir: makeDirectory,
        appName: "Ardor",
        packageJSON: { version: "0.4.4" },
        targetArch: "arm64",
      },
      runCommand,
    );

    assert.equal(artifactPath, join(makeDirectory, "Ardor-0.4.4-arm64.dmg"));
    assert.deepEqual(calls[0], [
      "/usr/bin/ditto",
      [join(packageDirectory, "Ardor.app"), join(stagingDirectory, "Ardor.app")],
    ]);
    assert.deepEqual(calls[1], [
      "/usr/bin/hdiutil",
      [
        "create",
        "-volname",
        "Ardor",
        "-srcfolder",
        stagingDirectory,
        "-format",
        "UDZO",
        "-ov",
        "-o",
        artifactPath,
      ],
    ]);
    assert.equal(existsSync(stagingDirectory), false);
  });
});

test("fails when the packaged application is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ardor-dmg-missing-"));
  try {
    await assert.rejects(
      createDmgArtifact({
        dir: root,
        makeDir: join(root, "make"),
        appName: "Ardor",
        packageJSON: { version: "0.4.4" },
        targetArch: "arm64",
      }),
      /application is missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for unsafe artifact path components", async () => {
  await assert.rejects(
    createDmgArtifact({
      dir: "/tmp",
      makeDir: "/tmp",
      appName: "../Ardor",
      packageJSON: { version: "0.4.4" },
      targetArch: "arm64",
    }),
    /Application name/,
  );
});

test("removes staging data when hdiutil fails", async () => {
  await withFixture(async ({ packageDirectory, makeDirectory }) => {
    let stagingDirectory;
    const runCommand = async (command, args) => {
      if (command === "/usr/bin/hdiutil") {
        stagingDirectory = args[args.indexOf("-srcfolder") + 1];
        throw new Error("hdiutil failed");
      }
    };

    await assert.rejects(
      createDmgArtifact(
        {
          dir: packageDirectory,
          makeDir: makeDirectory,
          appName: "Ardor",
          packageJSON: { version: "0.4.4" },
          targetArch: "arm64",
        },
        runCommand,
      ),
      /hdiutil failed/,
    );
    assert.equal(existsSync(stagingDirectory), false);
  });
});

test("declares a darwin-only Forge maker with native tool requirements", () => {
  const maker = new MakerArdorDMG();
  assert.equal(maker.name, "dmg");
  assert.deepEqual(maker.platforms, ["darwin"]);
  assert.deepEqual(maker.requiredExternalBinaries, ["ditto", "hdiutil"]);
});
