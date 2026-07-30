import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { withCefBuildEnv } from "./cef-build-env.mjs";

assert.equal(process.platform, "darwin", "WindowServer tests require macOS");
assert.equal(process.arch, "arm64", "WindowServer tests require Apple Silicon");

const appName = "Ardor Metal WindowServer";
const helperSuffixes = [
  "Helper (GPU)",
  "Helper (Renderer)",
  "Helper (Plugin)",
  "Helper (Alerts)",
  "Helper",
];
const frameworkName = "Chromium Embedded Framework.framework";
const bundleRoot = resolve(
  "src-tauri/target/macos-metal-windowserver",
  `${appName}.app`,
);
const cefRoot = resolve("src-tauri/cef-cache");
const buildEnv = withCefBuildEnv({
  ...process.env,
  CEF_PATH: cefRoot,
  CARGO_TARGET_DIR: resolve("src-tauri/target"),
  MACOSX_DEPLOYMENT_TARGET: "13.0",
});

function fail(message) {
  console.error(`Metal acceptance setup failed: ${message}`);
  process.exit(1);
}

function infoPlist(executableName, identifier, helper) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${executableName}</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${identifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${executableName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  ${helper ? "<key>LSUIElement</key>\n  <true/>" : ""}
</dict>
</plist>
`;
}

function createHelperBundle(frameworksDir, suffix, executable) {
  const helperName = `${appName} ${suffix}`;
  const helperRoot = join(frameworksDir, `${helperName}.app`, "Contents");
  const helperExecutable = join(helperRoot, "MacOS", helperName);
  mkdirSync(join(helperRoot, "MacOS"), { recursive: true });
  linkSync(executable, helperExecutable);
  writeFileSync(
    join(helperRoot, "Info.plist"),
    infoPlist(
      helperName,
      `com.ardor.metal-windowserver.${suffix.replaceAll(/[^A-Za-z]/g, "").toLowerCase()}`,
      true,
    ),
  );
}

const build = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--features",
    "metal-integration-tests",
    "--test",
    "macos_metal_windowserver",
    "--no-run",
    "--message-format=json",
    "--color=never",
  ],
  {
    env: buildEnv,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  },
);
if (build.error) fail("cargo could not be started");
if (build.status !== 0) process.exit(build.status ?? 1);

const testExecutable = build.stdout
  .split("\n")
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  })
  .findLast(
    (message) =>
      message.reason === "compiler-artifact" &&
      message.target?.name === "macos_metal_windowserver" &&
      message.executable,
  )?.executable;
if (!testExecutable || !existsSync(testExecutable)) {
  fail("Cargo did not report the macOS Metal WindowServer test executable.");
}

const cefFramework = join(
  cefRoot,
  "150.0.10",
  "cef_macos_aarch64",
  frameworkName,
);
if (!existsSync(cefFramework)) {
  fail("the pinned CEF framework was not downloaded");
}

rmSync(bundleRoot, { force: true, recursive: true });
const contentsDir = join(bundleRoot, "Contents");
const frameworksDir = join(contentsDir, "Frameworks");
const executableDir = join(contentsDir, "MacOS");
const bundledExecutable = join(executableDir, appName);
mkdirSync(frameworksDir, { recursive: true });
mkdirSync(executableDir, { recursive: true });
copyFileSync(testExecutable, bundledExecutable);
chmodSync(bundledExecutable, statSync(testExecutable).mode);
cpSync(cefFramework, join(frameworksDir, frameworkName), {
  recursive: true,
});
writeFileSync(
  join(contentsDir, "Info.plist"),
  infoPlist(appName, "com.ardor.metal-windowserver", false),
);
for (const suffix of helperSuffixes) {
  createHelperBundle(frameworksDir, suffix, bundledExecutable);
}

console.log(`MACOS_METAL_TEST_BUNDLE=${bundleRoot}`);
console.log(`MACOS_METAL_TEST_EXECUTABLE=${basename(testExecutable)}`);
const result = spawnSync(bundledExecutable, [], {
  env: buildEnv,
  stdio: "inherit",
});
if (result.error) fail("the Metal acceptance bundle could not be started");
process.exit(result.status ?? 1);
