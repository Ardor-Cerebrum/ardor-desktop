import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verifierPath = join(repoDir, "scripts/verify-desktop-ui-contract.mjs");

test("accepts an Electron-only solutions-ui preload contract", () => {
  withUiFixture({}, (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified Electron solutions-ui bridge/);
  });
});

test("rejects legacy runtime dependencies", () => {
  withUiFixture({ dependency: true }, (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden legacy runtime package/);
  });
});

test("rejects a missing preload capability", () => {
  withUiFixture({ omitCapability: "windowChrome" }, (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /required Electron bridge capability windowChrome is missing/);
  });
});

test("rejects a missing external browser capability", () => {
  withUiFixture({ omitCapability: "external" }, (uiDir) => {
    const result = runVerifier(uiDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /required Electron bridge capability external is missing/);
  });
});

test("rejects a solutions-ui path outside the current workspace", () => {
  const result = spawnSync(process.execPath, [verifierPath, "../outside-workspace"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /solutions-ui directory must be an approved direct child/);
});

test("rejects a checkout ref that differs from the pinned requirements ref", () => {
  withUiFixture({}, (uiDir) => {
    const result = runVerifier(uiDir, "0000000000000000000000000000000000000000");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match required ref/);
  });
});

test("accepts an explicit immutable requirements snapshot for a resumed release", () => {
  withUiFixture({}, (uiDir) => {
    const requirementsPath = join(dirname(uiDir), ".desktop-ui-requirements.snapshot.json");
    const solutionsUiRef = "0000000000000000000000000000000000000000";
    writeFileSync(
      requirementsPath,
      JSON.stringify({
        schemaVersion: 2,
        solutionsUiRef,
        bridgeGlobal: "ardorDesktop",
        requiredCapabilities: [
          "runtime",
          "windowChrome",
          "auth",
          "update",
          "browserProfile",
          "browserPane",
          "browserAgent",
          "artifactPane",
          "external",
        ],
      }),
    );
    const result = runVerifier(uiDir, solutionsUiRef, true);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("rejects arbitrary requirements path sources", () => {
  withUiFixture({}, (uiDir) => {
    const result = runVerifier(uiDir, undefined, "../../etc/passwd");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requirements source must be workspace-snapshot/);
  });
});

test("does not interpolate capability names into a regular expression", () => {
  const source = readFileSync(verifierPath, "utf8");
  assert.doesNotMatch(source, /new RegExp\([^\n]*capability/);
});

function withUiFixture(options, callback) {
  const workspace = mkdtempSync(join(tmpdir(), "ardor-electron-ui-contract-"));
  const uiDir = join(workspace, "solutions-ui");
  mkdirSync(join(uiDir, "src/lib"), { recursive: true });
  mkdirSync(join(uiDir, "src/auth"), { recursive: true });
  const capabilities = [
    "runtime",
    "windowChrome",
    "auth",
    "update",
    "browserProfile",
    "browserPane",
    "browserAgent",
    "artifactPane",
    "external",
  ]
    .filter((capability) => capability !== options.omitCapability)
    .map((capability) => `${capability}: {}`)
    .join(",\n");
  writeFileSync(
    join(uiDir, "package.json"),
    JSON.stringify({ dependencies: options.dependency ? { "@tauri-apps/api": "2" } : {} }),
  );
  writeFileSync(join(uiDir, "src/lib/desktop-bridge.ts"), `const bridge = window.ardorDesktop;\n${capabilities};\n`);
  writeFileSync(
    join(uiDir, "src/auth/auth0-provider-with-navigation.tsx"),
    "export const Provider = () => <DesktopAuthCallbackBridge />;\n",
  );

  try {
    callback(uiDir);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runVerifier(uiDir, ref, requirementsSource) {
  return spawnSync(process.execPath, [verifierPath, basename(uiDir), ref].filter(Boolean), {
    cwd: dirname(uiDir),
    encoding: "utf8",
    env: {
      ...process.env,
      ...(requirementsSource
        ? {
            ARDOR_DESKTOP_UI_REQUIREMENTS_SOURCE:
              requirementsSource === true ? "workspace-snapshot" : requirementsSource,
          }
        : {}),
    },
  });
}
