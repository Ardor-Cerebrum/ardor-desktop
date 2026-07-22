import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCefBuildPaths } from './cef-build-env.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const srcTauriDir = resolve(desktopDir, 'src-tauri');
const { targetDir, cefPath } = resolveCefBuildPaths(process.env);
const targetRoot = resolve(desktopDir, targetDir);
const profile = process.env.TAURI_ENV_DEBUG === 'true' ? 'debug' : 'release';
const windowsTarget = 'x86_64-pc-windows-msvc';
const unknownBundleToken = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const bundleTokens = {
  nsis: Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS'),
  msi: Buffer.from('__TAURI_BUNDLE_TYPE_VAR_MSI'),
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function firstExisting(paths, kind, minimumSize = 1) {
  const path = paths.find((candidate) => existsSync(candidate) && statSync(candidate).size >= minimumSize);
  if (!path) {
    fail(`${kind} was not found. Checked:\n${paths.map((candidate) => `- ${candidate}`).join('\n')}`);
  }
  return path;
}

function prepareBundleTypeMarker(path, bundleType, appendIfMissing) {
  const replacement = bundleTokens[bundleType];
  if (!replacement) {
    fail(`Unsupported Windows bundle type for the CEF bootstrap: ${bundleType}`);
  }

  let binary = readFileSync(path);
  const markerIndex = binary.indexOf(unknownBundleToken);
  if (markerIndex === -1) {
    if (!appendIfMissing) {
      fail(`Tauri bundle type marker was not found in ${path}`);
    }
    binary = Buffer.concat([binary, unknownBundleToken]);
  } else {
    replacement.copy(binary, markerIndex);
  }
  writeFileSync(path, binary);
}

if (process.env.TAURI_ENV_PLATFORM && process.env.TAURI_ENV_PLATFORM !== 'windows') {
  console.log(`Skipping CEF bootstrap preparation for ${process.env.TAURI_ENV_PLATFORM}`);
  process.exit(0);
}

const outputDirs = [resolve(targetRoot, windowsTarget, profile), resolve(targetRoot, profile)];
const clientDll = firstExisting(
  outputDirs.flatMap((directory) => [
    resolve(directory, 'deps', 'ardor_solutions_desktop_lib.dll'),
    resolve(directory, 'ardor_solutions_desktop_lib.dll'),
  ]),
  'CEF bootstrap client DLL',
  1024 * 1024,
);
const applicationExe = firstExisting(
  outputDirs.map((directory) => resolve(directory, 'ardor-solutions-desktop.exe')),
  'Tauri application executable',
);
const bootstrapExe = firstExisting(
  [
    resolve(desktopDir, cefPath, '150.0.10', 'cef_windows_x86_64', 'bootstrap.exe'),
    ...outputDirs.map((directory) => resolve(directory, 'bootstrap.exe')),
  ],
  'CEF M138+ sandbox bootstrap executable',
);

const generatedDir = resolve(srcTauriDir, 'generated');
const packagedClientDll = resolve(generatedDir, 'ardor-solutions-desktop.dll');
const adjacentClientDll = resolve(dirname(applicationExe), 'ardor-solutions-desktop.dll');
const bundleType = process.env.ARDOR_WINDOWS_BUNDLE_TYPE?.trim().toLowerCase() || 'nsis';
mkdirSync(generatedDir, { recursive: true });
copyFileSync(clientDll, packagedClientDll);
copyFileSync(clientDll, adjacentClientDll);
copyFileSync(bootstrapExe, applicationExe);
prepareBundleTypeMarker(packagedClientDll, bundleType, false);
prepareBundleTypeMarker(adjacentClientDll, bundleType, false);
prepareBundleTypeMarker(applicationExe, bundleType, true);

for (const path of [packagedClientDll, adjacentClientDll, applicationExe]) {
  const size = statSync(path).size;
  if (size === 0) {
    fail(`Prepared bootstrap artifact is empty: ${path}`);
  }
  console.log(`CEF_BOOTSTRAP_ARTIFACT=${basename(path)} size=${size} path=${path}`);
}
console.log(`CEF_BOOTSTRAP_BUNDLE_TYPE=${bundleType}`);
