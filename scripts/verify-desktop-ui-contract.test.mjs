import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("rejects a solutions-ui path outside the current workspace", () => {
  const result = spawnSync(process.execPath, [verifierPath, "../outside-workspace"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /solutions-ui directory must be a direct child/);
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
    "sidebarBrowser",
    "browserProfile",
    "browserPane",
    "artifactPane",
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

function runVerifier(uiDir) {
  return spawnSync(process.execPath, [verifierPath, basename(uiDir)], {
    cwd: dirname(uiDir),
    encoding: "utf8",
  });
}
