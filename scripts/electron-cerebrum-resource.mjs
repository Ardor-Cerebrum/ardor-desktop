import { createHash } from "node:crypto";
import { chmod, cp, lstat, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAC_EXECUTABLES = [
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/zsh/bin/zsh",
];

export function resolveCerebrumRuntimePin(environment, platform, arch) {
  const bundleDirectory = environment.ARDOR_CEREBRUM_BUNDLE_DIR?.trim();
  const archivePath = environment.ARDOR_CEREBRUM_ARCHIVE_PATH?.trim();
  const archiveSha256 = environment.ARDOR_CEREBRUM_ARCHIVE_SHA256?.trim();
  const sourceCommit = environment.ARDOR_CEREBRUM_SOURCE_SHA?.trim();
  const hasAnyPinInput = [bundleDirectory, archivePath, archiveSha256, sourceCommit].some(Boolean);
  if (!hasAnyPinInput) return undefined;
  if (!bundleDirectory || !archivePath || !archiveSha256 || !sourceCommit) {
    throw new Error("Cerebrum packaging requires a bundle, archive, archive digest, and source commit pin");
  }
  return verifyCerebrumRuntimePin({
    archivePath,
    archiveSha256,
    bundleDirectory,
    sourceCommit,
    platform,
    arch,
  });
}

export function verifyCerebrumRuntimePin({
  archivePath,
  archiveSha256,
  bundleDirectory,
  sourceCommit,
  platform,
  arch,
}) {
  const target = platform === "darwin" && arch === "arm64"
    ? "aarch64-apple-darwin"
    : platform === "win32" && arch === "x64"
      ? "x86_64-pc-windows-msvc"
      : undefined;
  if (!target || typeof bundleDirectory !== "string" || !bundleDirectory ||
      typeof archivePath !== "string" || !archivePath ||
      typeof sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(sourceCommit) ||
      typeof archiveSha256 !== "string" || !/^[0-9a-f]{64}$/.test(archiveSha256) ||
      !existsSync(bundleDirectory) || !existsSync(archivePath)) {
    throw new Error("Cerebrum runtime pin is invalid");
  }
  const archiveDigest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (archiveDigest !== archiveSha256) {
    throw new Error("Cerebrum runtime archive digest does not match its trusted pin");
  }
  const manifestBytes = readFileSync(resolve(bundleDirectory, "manifest.json"));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.source?.repository !== "Ardor-Cerebrum/cerebrum" || manifest.source.commit !== sourceCommit) {
    throw new Error("Cerebrum runtime source commit does not match its trusted pin");
  }
  if (manifest.target !== target || manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error("Cerebrum runtime manifest target does not match the Desktop package");
  }
  return { sourceCommit, manifestSha256 };
}

export async function normalizeCerebrumResourceDirectory(packageRoot, sourceResourceName, platform = process.platform) {
  if (!sourceResourceName || sourceResourceName.includes("/") || sourceResourceName.includes("\\")) {
    throw new Error("Cerebrum resource name must be a single path component");
  }
  const resourcesRoot = await resolveResourcesRoot(packageRoot, platform);
  const sourceDirectory = resolve(resourcesRoot, sourceResourceName);
  const destinationDirectory = resolve(resourcesRoot, "cerebrum");
  if (sourceDirectory !== destinationDirectory) {
    const sourceStats = await lstat(sourceDirectory).catch(() => null);
    if (!sourceStats?.isDirectory() || sourceStats.isSymbolicLink()) {
      throw new Error("Cerebrum runtime resource directory is missing or invalid");
    }
    const destinationStats = await lstat(destinationDirectory).catch(() => null);
    if (destinationStats) {
      throw new Error("Cerebrum resource destination already exists");
    }
    await cp(sourceDirectory, destinationDirectory, { dereference: false, recursive: true, verbatimSymlinks: true });
    await rm(sourceDirectory, { recursive: true, force: true });
  }
  if (platform === "darwin") await restoreMacExecutablePermissions(destinationDirectory);
}

async function restoreMacExecutablePermissions(bundleRoot) {
  for (const relativePath of MAC_EXECUTABLES) {
    const executablePath = resolve(bundleRoot, relativePath);
    const stats = await lstat(executablePath).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Bundled Cerebrum helper is missing or invalid: ${relativePath}`);
    }
    await chmod(executablePath, (stats.mode & 0o777) | 0o111);
  }
}

async function resolveResourcesRoot(packageRoot, platform) {
  if (platform !== "darwin") return resolve(packageRoot, "resources");
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const appBundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appBundle) throw new Error(`Electron macOS app bundle is missing under ${packageRoot}`);
  return resolve(packageRoot, appBundle.name, "Contents", "Resources");
}
