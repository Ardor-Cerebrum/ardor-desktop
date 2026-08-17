import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, readFile } from "node:fs/promises";
import { basename, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function listFiles(root) {
  const rootStats = await stat(root).catch(() => null);
  invariant(rootStats?.isDirectory(), `Electron Forge make directory is missing: ${root}`);

  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
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

async function requireNonEmpty(file, description) {
  const fileStats = await stat(file).catch(() => null);
  invariant(fileStats?.isFile() && fileStats.size > 0, `${description} is missing or empty: ${file}`);
  return fileStats;
}

async function prepareDestination(directory) {
  const root = parse(directory).root;
  invariant(directory !== root, "Refusing to use a filesystem root as the release asset destination");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

async function copy(source, destination) {
  await copyFile(source, destination);
  await requireNonEmpty(destination, "Collected release asset");
  return destination;
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

async function validateSquirrelRelease(releasesFile, packageFile) {
  const lines = (await readFile(releasesFile, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  invariant(lines.length === 1, `Expected one Squirrel RELEASES entry, found ${lines.length}`);

  const fields = lines[0].split(/\s+/);
  invariant(fields.length === 3, "Squirrel RELEASES entry must contain hash, package name, and size");
  const [declaredHash, declaredName, declaredSize] = fields;
  const packageStats = await requireNonEmpty(packageFile, "Squirrel package");
  invariant(declaredName === basename(packageFile), "Squirrel RELEASES references a different package");
  invariant(Number(declaredSize) === packageStats.size, "Squirrel RELEASES package size does not match");
  invariant(declaredHash.toLowerCase() === (await sha1(packageFile)), "Squirrel RELEASES package hash does not match");
}

export async function collectElectronReleaseAssets({
  platform,
  arch,
  releaseTag,
  packageVersion,
  makeDirectory,
  destinationDirectory,
  appName = "Ardor",
}) {
  invariant(releaseTag === `v${packageVersion}`, `Release tag ${releaseTag} does not match package version ${packageVersion}`);

  const files = await listFiles(resolve(makeDirectory));
  const target = resolveReleaseTarget({ platform, arch, files });
  await prepareDestination(resolve(destinationDirectory));

  if (target.platform === "darwin") {
    const zip = exactlyOne(files, (file) => file.endsWith(".zip"), "macOS ZIP asset");
    const dmg = exactlyOne(files, (file) => file.endsWith(".dmg"), "macOS DMG asset");
    await requireNonEmpty(zip, "macOS ZIP asset");
    await requireNonEmpty(dmg, "macOS DMG asset");
    return [
      await copy(zip, resolve(destinationDirectory, `${appName}-${releaseTag}-mac-${target.arch}.zip`)),
      await copy(dmg, resolve(destinationDirectory, `${appName}-${releaseTag}-mac-${target.arch}.dmg`)),
    ];
  }

  const installer = exactlyOne(files, (file) => file.toLowerCase().endsWith(".exe"), "Windows installer");
  const packageFile = exactlyOne(files, (file) => file.toLowerCase().endsWith(".nupkg"), "Squirrel package");
  const releasesFile = exactlyOne(files, (file) => basename(file) === "RELEASES", "Squirrel RELEASES file");
  await requireNonEmpty(installer, "Windows installer");
  await validateSquirrelRelease(releasesFile, packageFile);

  return [
    await copy(installer, resolve(destinationDirectory, `${appName}-${releaseTag}-win32-${target.arch}-setup.exe`)),
    await copy(packageFile, resolve(destinationDirectory, basename(packageFile))),
    await copy(releasesFile, resolve(destinationDirectory, "RELEASES")),
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
  const releaseTag = process.env.RELEASE_TAG ?? process.argv[3];
  const arch = process.env.ARDOR_DESKTOP_TARGET_ARCH;
  invariant(releaseTag, "RELEASE_TAG is required");
  const assets = await collectElectronReleaseAssets({
    platform,
    arch,
    releaseTag,
    packageVersion: packageJson.version,
    makeDirectory: resolve(repositoryRoot, process.argv[4] ?? "out/make"),
    destinationDirectory: resolve(repositoryRoot, process.argv[5] ?? "dist/release"),
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
