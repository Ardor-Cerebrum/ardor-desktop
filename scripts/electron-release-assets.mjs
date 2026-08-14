import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertPathWithin(root, candidate, label) {
  const relativePath = relative(root, candidate);
  invariant(
    relativePath !== "" &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath),
    `${label} must be inside the release workspace`,
  );
}

async function resolveExistingPathWithin(root, candidate, label) {
  const resolvedRoot = realpathSync(resolve(root));
  const resolvedCandidate = await realpath(resolve(candidate));
  assertPathWithin(resolvedRoot, resolvedCandidate, label);
  return resolvedCandidate;
}

async function resolveWritablePathWithin(root, candidate, label) {
  const resolvedRoot = realpathSync(resolve(root));
  const resolvedParent = await realpath(dirname(resolve(candidate)));
  if (resolvedParent !== resolvedRoot) {
    assertPathWithin(resolvedRoot, resolvedParent, `${label} parent`);
  }
  const resolvedCandidate = resolve(resolvedParent, basename(candidate));
  assertPathWithin(resolvedRoot, resolvedCandidate, label);
  return resolvedCandidate;
}

async function listFiles(root) {
  const rootStats = await stat(root).catch(() => null);
  invariant(rootStats?.isDirectory(), `Electron Forge make directory is missing: ${root}`);

  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = await realpath(resolve(directory, entry.name));
      const relativeEntryPath = relative(root, entryPath);
      if (
        relativeEntryPath === ".." ||
        relativeEntryPath.startsWith(`..${sep}`) ||
        isAbsolute(relativeEntryPath)
      ) {
        throw new Error("Electron Forge artifact must be inside the make directory");
      }
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  };
  await visit(root);
  return files;
}

function exactlyOne(files, predicate, description) {
  const matches = files.filter(predicate);
  invariant(matches.length === 1, `Expected exactly one ${description}, found ${matches.length}`);
  return matches[0];
}

async function requireNonEmpty(root, file, description) {
  const safeRoot = realpathSync(root);
  const safeFile = await realpath(file);
  invariant(safeFile.startsWith(`${safeRoot}${sep}`), `${description} must be inside ${safeRoot}`);
  const fileStats = await stat(safeFile).catch(() => null);
  invariant(fileStats?.isFile() && fileStats.size > 0, `${description} is missing or empty: ${safeFile}`);
  return fileStats;
}

async function prepareDestination(directory) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

async function copy(sourceRoot, source, destinationRoot, destinationName) {
  const safeSourceRoot = realpathSync(sourceRoot);
  const safeSource = await realpath(source);
  invariant(safeSource.startsWith(`${safeSourceRoot}${sep}`), `Release asset source must be inside ${safeSourceRoot}`);

  const safeDestinationRoot = realpathSync(destinationRoot);
  const safeDestination = resolve(safeDestinationRoot, basename(destinationName));
  invariant(
    safeDestination.startsWith(`${safeDestinationRoot}${sep}`),
    `Release asset destination must be inside ${safeDestinationRoot}`,
  );
  await copyFile(safeSource, safeDestination);
  const destinationStats = await stat(safeDestination).catch(() => null);
  invariant(
    destinationStats?.isFile() && destinationStats.size > 0,
    `Collected release asset is missing or empty: ${safeDestination}`,
  );
  return safeDestination;
}

async function sha1(file) {
  const hash = createHash("sha1");
  await new Promise((resolvePromise, rejectPromise) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", rejectPromise)
      .on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function validateSquirrelRelease(root, releasesFile, packageFile) {
  const safeRoot = realpathSync(root);
  const safeReleasesFile = await realpath(releasesFile);
  const safePackageFile = await realpath(packageFile);
  invariant(safeReleasesFile.startsWith(`${safeRoot}${sep}`), `Squirrel RELEASES must be inside ${safeRoot}`);
  invariant(safePackageFile.startsWith(`${safeRoot}${sep}`), `Squirrel package must be inside ${safeRoot}`);

  const lines = (await readFile(safeReleasesFile, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  invariant(lines.length === 1, `Expected one Squirrel RELEASES entry, found ${lines.length}`);

  const fields = lines[0].split(/\s+/);
  invariant(fields.length === 3, "Squirrel RELEASES entry must contain hash, package name, and size");
  const [declaredHash, declaredName, declaredSize] = fields;
  const packageStats = await requireNonEmpty(safeRoot, safePackageFile, "Squirrel package");
  invariant(declaredName === basename(safePackageFile), "Squirrel RELEASES references a different package");
  invariant(Number(declaredSize) === packageStats.size, "Squirrel RELEASES package size does not match");
  invariant(declaredHash.toLowerCase() === (await sha1(safePackageFile)), "Squirrel RELEASES package hash does not match");
}

export async function collectElectronReleaseAssets({
  workspaceRoot,
  platform,
  arch,
  releaseTag,
  packageVersion,
  makeDirectory,
  destinationDirectory,
  appName = "Ardor",
}) {
  invariant(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion),
    `Package version contains unsafe path characters: ${packageVersion}`,
  );
  const canonicalReleaseTag = `v${packageVersion}`;
  invariant(releaseTag === canonicalReleaseTag, `Release tag ${releaseTag} does not match package version ${packageVersion}`);
  invariant(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(appName), "Application name contains unsafe path characters");

  const safeMakeDirectory = await resolveExistingPathWithin(workspaceRoot, makeDirectory, "Electron Forge make directory");
  const safeDestinationDirectory = await resolveWritablePathWithin(
    workspaceRoot,
    destinationDirectory,
    "Release asset destination",
  );
  const files = await listFiles(safeMakeDirectory);
  const target = resolveReleaseTarget({ platform, arch, files });
  await prepareDestination(safeDestinationDirectory);

  if (target.platform === "darwin") {
    const dmg = exactlyOne(files, (file) => file.endsWith(".dmg"), "macOS DMG asset");
    await requireNonEmpty(safeMakeDirectory, dmg, "macOS DMG asset");
    return [
      await copy(
        safeMakeDirectory,
        dmg,
        safeDestinationDirectory,
        `${appName}-${canonicalReleaseTag}-mac-${target.arch}-unsigned.dmg`,
      ),
    ];
  }

  const installer = exactlyOne(files, (file) => file.toLowerCase().endsWith(".exe"), "Windows installer");
  const packageFile = exactlyOne(files, (file) => file.toLowerCase().endsWith(".nupkg"), "Squirrel package");
  const releasesFile = exactlyOne(files, (file) => basename(file) === "RELEASES", "Squirrel RELEASES file");
  await requireNonEmpty(safeMakeDirectory, installer, "Windows installer");
  await validateSquirrelRelease(safeMakeDirectory, releasesFile, packageFile);

  return [
    await copy(
      safeMakeDirectory,
      installer,
      safeDestinationDirectory,
      `${appName}-${canonicalReleaseTag}-windows-${target.arch}-unsigned-setup.exe`,
    ),
  ];
}

export function resolveReleaseTarget({ platform, arch, files = [] }) {
  if (platform === "darwin") {
    const resolvedArch = arch ?? inferArch(files);
    invariant(resolvedArch === "arm64", `Unsupported macOS release architecture: ${resolvedArch ?? "unknown"}`);
    return { platform, arch: resolvedArch };
  }
  if (platform === "win32") {
    const resolvedArch = arch ?? inferArch(files) ?? "x64";
    invariant(resolvedArch === "x64", `Unsupported Windows release architecture: ${resolvedArch}`);
    return { platform, arch: resolvedArch };
  }
  throw new Error(`Unsupported Electron release platform: ${platform}`);
}

function inferArch(files) {
  const detected = new Set();
  for (const file of files) {
    const normalized = file.replace(/\\/g, "/").toLowerCase();
    if (/(^|[-/])arm64($|[-/.])/.test(normalized)) detected.add("arm64");
    if (/(^|[-/])x64($|[-/.])/.test(normalized)) detected.add("x64");
  }
  return detected.size === 1 ? [...detected][0] : undefined;
}

export async function main() {
  const platform = process.argv[2];
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const requestedReleaseTag = process.env.RELEASE_TAG ?? process.argv[3];
  const arch = process.env.ARDOR_DESKTOP_TARGET_ARCH;
  invariant(process.argv.length <= 4, "Custom release asset paths are not supported");
  invariant(requestedReleaseTag, "RELEASE_TAG is required");
  const releaseTag = `v${packageJson.version}`;
  invariant(requestedReleaseTag === releaseTag, `Release tag ${requestedReleaseTag} does not match package version ${packageJson.version}`);
  const assets = await collectElectronReleaseAssets({
    workspaceRoot: repositoryRoot,
    platform,
    arch,
    releaseTag,
    packageVersion: packageJson.version,
    makeDirectory: resolve(repositoryRoot, "out/make"),
    destinationDirectory: resolve(repositoryRoot, "dist/release"),
  });
  for (const asset of assets) console.log(asset);
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
