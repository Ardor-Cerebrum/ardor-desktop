import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { chmod, cp, lstat, readdir, rm } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const CEREBRUM_REQUIREMENTS = JSON.parse(
  readFileSync(new URL("../desktop-cerebrum-requirements.json", import.meta.url), "utf8"),
);
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
  if (sourceCommit !== CEREBRUM_REQUIREMENTS.sourceCommit) {
    throw new Error("Cerebrum runtime source commit does not match Desktop requirements");
  }
  const archiveBytes = readFileSync(archivePath);
  const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
  if (archiveDigest !== archiveSha256) {
    throw new Error("Cerebrum runtime archive digest does not match its trusted pin");
  }
  const manifestBytes = readZipEntry(archiveBytes, "manifest.json");
  const bundleManifestBytes = readFileSync(resolve(bundleDirectory, "manifest.json"));
  if (!manifestBytes.equals(bundleManifestBytes)) {
    throw new Error("Cerebrum bundle manifest does not match the pinned archive");
  }
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest?.schemaVersion !== 1 || manifest?.source?.repository !== CEREBRUM_REQUIREMENTS.repository ||
      manifest.source.commit !== sourceCommit) {
    throw new Error("Cerebrum runtime source commit does not match its trusted pin");
  }
  const protocol = CEREBRUM_REQUIREMENTS.protocol;
  if (manifest.protocol?.name !== protocol.name || manifest.protocol.version !== protocol.version ||
      manifest.protocol.transport !== protocol.transport ||
      JSON.stringify(manifest.protocol.args) !== JSON.stringify(protocol.args)) {
    throw new Error("Cerebrum runtime protocol does not match Desktop requirements");
  }
  if (manifest.target !== target || manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error("Cerebrum runtime manifest target does not match the Desktop package");
  }
  verifyBundleFiles(bundleDirectory, manifest.files);
  return { sourceCommit, manifestSha256 };
}

function readZipEntry(archiveBytes, targetName) {
  const endSignature = 0x06054b50;
  const endStart = Math.max(0, archiveBytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = archiveBytes.byteLength - 22; offset >= endStart; offset -= 1) {
    if (archiveBytes.readUInt32LE(offset) !== endSignature) continue;
    const commentLength = archiveBytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archiveBytes.byteLength) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("Cerebrum runtime archive is not a supported ZIP file");

  const entryCount = archiveBytes.readUInt16LE(endOffset + 10);
  const directorySize = archiveBytes.readUInt32LE(endOffset + 12);
  const directoryOffset = archiveBytes.readUInt32LE(endOffset + 16);
  const directoryEnd = directoryOffset + directorySize;
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || directoryEnd > endOffset) {
    throw new Error("Cerebrum runtime archive uses an unsupported ZIP layout");
  }

  let offset = directoryOffset;
  let manifestBytes;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryEnd || archiveBytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Cerebrum runtime archive has an invalid central directory");
    }
    const flags = archiveBytes.readUInt16LE(offset + 8);
    const method = archiveBytes.readUInt16LE(offset + 10);
    const compressedSize = archiveBytes.readUInt32LE(offset + 20);
    const uncompressedSize = archiveBytes.readUInt32LE(offset + 24);
    const filenameLength = archiveBytes.readUInt16LE(offset + 28);
    const extraLength = archiveBytes.readUInt16LE(offset + 30);
    const commentLength = archiveBytes.readUInt16LE(offset + 32);
    const localHeaderOffset = archiveBytes.readUInt32LE(offset + 42);
    const filenameOffset = offset + 46;
    const nextOffset = filenameOffset + filenameLength + extraLength + commentLength;
    if (nextOffset > directoryEnd) throw new Error("Cerebrum runtime archive has an invalid central directory");
    const filename = archiveBytes.subarray(filenameOffset, filenameOffset + filenameLength).toString("utf8");
    if (filename === targetName) {
      if (manifestBytes) throw new Error("Cerebrum runtime archive contains duplicate manifests");
      if ((flags & 1) !== 0 || uncompressedSize > 1_048_576 || localHeaderOffset + 30 > directoryOffset) {
        throw new Error("Cerebrum runtime archive manifest entry is invalid");
      }
      if (archiveBytes.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error("Cerebrum runtime archive manifest header is invalid");
      }
      const localFilenameLength = archiveBytes.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archiveBytes.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
      const dataEnd = dataOffset + compressedSize;
      if (dataEnd > directoryOffset) throw new Error("Cerebrum runtime archive manifest data is invalid");
      const compressed = archiveBytes.subarray(dataOffset, dataEnd);
      if (method === 0) {
        manifestBytes = compressed;
      } else if (method === 8) {
        manifestBytes = inflateRawSync(compressed, { maxOutputLength: 1_048_576 });
      } else {
        throw new Error("Cerebrum runtime archive manifest compression is unsupported");
      }
      if (manifestBytes.byteLength !== uncompressedSize) {
        throw new Error("Cerebrum runtime archive manifest size is invalid");
      }
    }
    offset = nextOffset;
  }
  if (offset !== directoryEnd || !manifestBytes) {
    throw new Error("Cerebrum runtime archive is missing its manifest");
  }
  return manifestBytes;
}

function verifyBundleFiles(bundleDirectory, files) {
  if (!Array.isArray(files)) throw new Error("Cerebrum runtime manifest has no file list");
  const bundleRoot = realpathSync(bundleDirectory);
  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== "string" || !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0 || typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error("Cerebrum runtime manifest file entry is invalid");
    }
    const pathParts = file.path.split("/");
    if (pathParts.some((part) => part.length === 0 || part === "." || part === "..") || file.path.includes("\\")) {
      throw new Error("Cerebrum runtime manifest file path is invalid");
    }
    const path = resolve(bundleRoot, ...pathParts);
    const relativePath = relative(bundleRoot, path);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
      throw new Error("Cerebrum runtime manifest file escapes the bundle");
    }
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Cerebrum runtime bundle file is missing or linked: ${file.path}`);
    }
    const realPath = realpathSync(path);
    const resolvedRelativePath = relative(bundleRoot, realPath);
    if (!resolvedRelativePath || resolvedRelativePath.startsWith(`..${sep}`) || resolvedRelativePath === ".." || isAbsolute(resolvedRelativePath)) {
      throw new Error("Cerebrum runtime bundle file escapes the bundle");
    }
    const bytes = readFileSync(realPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== file.sizeBytes || digest !== file.sha256) {
      throw new Error(`Cerebrum runtime bundle file does not match its manifest: ${file.path}`);
    }
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
