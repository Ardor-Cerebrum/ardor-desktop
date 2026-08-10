import { execFile as execFileCallback } from "node:child_process";
import { stat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import makerBaseModule from "@electron-forge/maker-base";

const MakerBase = makerBaseModule.MakerBase ?? makerBaseModule;
const execFile = promisify(execFileCallback);

function assertSafePathComponent(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    basename(value) !== value ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a non-empty path component`);
  }
}

async function runSystemCommand(command, args) {
  await execFile(command, args, { maxBuffer: 10 * 1024 * 1024 });
}

export async function createDmgArtifact(
  { dir, makeDir, appName, packageJSON, targetArch },
  runCommand = runSystemCommand,
) {
  assertSafePathComponent(appName, "Application name");
  assertSafePathComponent(packageJSON?.version, "Application version");
  assertSafePathComponent(targetArch, "Target architecture");

  const appPath = resolve(dir, `${appName}.app`);
  const appStats = await stat(appPath).catch(() => null);
  if (!appStats?.isDirectory()) {
    throw new Error(`Packaged macOS application is missing: ${appPath}`);
  }

  const artifactPath = resolve(makeDir, `${appName}-${packageJSON.version}-${targetArch}.dmg`);
  await mkdir(dirname(artifactPath), { recursive: true });
  await rm(artifactPath, { force: true });

  const stagingDirectory = await mkdtemp(join(tmpdir(), "ardor-dmg-"));
  try {
    const stagedAppPath = join(stagingDirectory, `${appName}.app`);
    await runCommand("/usr/bin/ditto", [appPath, stagedAppPath]);
    await symlink("/Applications", join(stagingDirectory, "Applications"));
    await runCommand("/usr/bin/hdiutil", [
      "create",
      "-volname",
      appName,
      "-srcfolder",
      stagingDirectory,
      "-format",
      "UDZO",
      "-ov",
      "-o",
      artifactPath,
    ]);

    const artifactStats = await stat(artifactPath).catch(() => null);
    if (!artifactStats?.isFile() || artifactStats.size === 0) {
      throw new Error(`hdiutil did not create a non-empty DMG artifact: ${artifactPath}`);
    }
    return artifactPath;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export class MakerArdorDMG extends MakerBase {
  name = "dmg";
  defaultPlatforms = ["darwin"];
  requiredExternalBinaries = ["ditto", "hdiutil"];

  isSupportedOnCurrentPlatform() {
    return process.platform === "darwin";
  }

  async make(options) {
    return [await createDmgArtifact(options)];
  }
}
