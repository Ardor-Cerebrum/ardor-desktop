import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveElectronOutputTarget } from "./verify-electron-fuses.mjs";

async function withFixture(run) {
  const workspace = await mkdtemp(join(tmpdir(), "ardor-fuse-target-"));
  const outputDirectory = join(workspace, "out");
  await mkdir(outputDirectory);
  try {
    await run({ workspace, outputDirectory });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("accepts an Electron target inside out", async () => {
  await withFixture(async ({ workspace, outputDirectory }) => {
    const target = join(outputDirectory, "Ardor.app");
    await mkdir(target);
    assert.equal(resolveElectronOutputTarget(target, workspace), await realpath(target));
  });
});

test("rejects an Electron target outside out", async () => {
  await withFixture(async ({ workspace }) => {
    const target = join(workspace, "outside.exe");
    await writeFile(target, "outside");
    assert.throws(
      () => resolveElectronOutputTarget(target, workspace),
      /must be inside the current workspace out directory/,
    );
  });
});

test("rejects an out symlink that escapes the workspace", async () => {
  await withFixture(async ({ workspace, outputDirectory }) => {
    const target = join(workspace, "outside.exe");
    const link = join(outputDirectory, "Ardor.exe");
    await writeFile(target, "outside");
    await symlink(target, link);
    assert.throws(
      () => resolveElectronOutputTarget(link, workspace),
      /must be inside the current workspace out directory/,
    );
  });
});
