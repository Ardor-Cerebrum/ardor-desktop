import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const launcher = readFileSync(
  "scripts/macos-metal-windowserver.test.mjs",
  "utf8",
);
const integrationTest = readFileSync(
  "src-tauri/tests/macos_metal_windowserver.rs",
  "utf8",
);
const testSupport = readFileSync(
  "src-tauri/src/sidebar_browser/gpu_compositor/test_support.rs",
  "utf8",
);
const acceptance = readFileSync(
  "docs/testing/macos-metal-compositor.md",
  "utf8",
);

test("Apple Silicon Metal dependencies and accelerated OSR are target-scoped", () => {
  assert.match(
    cargo,
    /cfg\(all\(target_os = "macos", target_arch = "aarch64"\)\)/,
  );
  assert.match(cargo, /objc2-io-surface/);
  assert.match(cargo, /objc2-metal/);
  assert.match(cargo, /features = \["accelerated_osr", "build-util"\]/);
});

test("CI and release builds target macOS 13", () => {
  assert.match(ci, /MACOSX_DEPLOYMENT_TARGET: "13\.0"/);
  assert.match(release, /MACOSX_DEPLOYMENT_TARGET: "13\.0"/);
});

test("WindowServer acceptance is opt-in and Apple Silicon-only", () => {
  assert.match(cargo, /metal-integration-tests = \[\]/);
  assert.match(packageJson, /test:macos-metal-windowserver/);
  assert.match(launcher, /process\.platform, "darwin"/);
  assert.match(launcher, /process\.arch, "arm64"/);
  assert.match(cargo, /harness = false/);
  assert.match(integrationTest, /macos_metal_composition_order/);
  assert.match(integrationTest, /macos_metal_cef_lifecycle_stress_100/);
  assert.match(
    integrationTest,
    /ARDOR_TEST_METAL_CEF_LIFECYCLE_ITERATIONS/,
  );
  assert.match(ci, /macos-metal-windowserver:/);
});

test("WindowServer probe activates its AppKit window before presenting", () => {
  assert.match(testSupport, /setActivationPolicy\(NSApplicationActivationPolicy::Regular\)/);
  assert.match(testSupport, /activateIgnoringOtherApps\(true\)/);
  assert.match(testSupport, /makeKeyAndOrderFront\(None\)/);
  assert.match(testSupport, /updateWindows\(\)/);
});

test("manual Metal acceptance matrix covers overlay, input, and lifecycle risks", () => {
  for (const requirement of [
    "Select",
    "AlertDialog",
    "CEF context menu",
    "Japanese IME",
    "preview audio",
    "Retina",
    "artifact close",
    "runtime recovery fallback",
  ]) {
    assert.match(acceptance, new RegExp(requirement, "i"));
  }
});
