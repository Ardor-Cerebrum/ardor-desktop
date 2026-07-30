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
const compositor = readFileSync(
  "src-tauri/src/sidebar_browser/gpu_compositor/mod.rs",
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
  assert.match(launcher, /withCefBuildEnv/);
  assert.match(launcher, /--no-run/);
  assert.match(launcher, /"--release"/);
  assert.match(launcher, /Chromium Embedded Framework\.framework/);
  assert.match(launcher, /Helper \(Renderer\)/);
  assert.match(launcher, /cpSync\(cefFramework/);
  assert.match(cargo, /harness = false/);
  assert.match(integrationTest, /macos_metal_composition_order/);
  assert.match(integrationTest, /macos_metal_cef_lifecycle_stress_100/);
  assert.match(
    integrationTest,
    /ARDOR_TEST_METAL_CEF_LIFECYCLE_ITERATIONS/,
  );
  assert.match(testSupport, /lifecycle\.progress iteration=/);
  assert.ok(
    integrationTest.indexOf("macos_metal_cef_lifecycle_stress_100();") <
      integrationTest.indexOf("macos_metal_composition_order();"),
    "CEF must install the custom NSApplication before the standalone Metal probe",
  );
  assert.match(ci, /macos-metal-windowserver:/);
});

test("WindowServer probe activates its AppKit window before presenting", () => {
  assert.match(testSupport, /setActivationPolicy\(NSApplicationActivationPolicy::Regular\)/);
  assert.match(testSupport, /activateIgnoringOtherApps\(true\)/);
  assert.match(testSupport, /makeKeyAndOrderFront\(None\)/);
  assert.match(testSupport, /updateWindows\(\)/);
});

test("WindowServer probe retries transient occlusion while pumping AppKit", () => {
  assert.match(testSupport, /orderFrontRegardless\(\)/);
  assert.match(testSupport, /nextEventMatchingMask_untilDate_inMode_dequeue/);
  assert.match(testSupport, /CurrentSurfaceTexture::Occluded/);
  assert.match(testSupport, /SURFACE_ACQUIRE_TIMEOUT/);
});

test("CEF lifecycle resize stays within the runner's visible work area", () => {
  assert.match(testSupport, /initial_size\.width - 64\.0/);
  assert.match(testSupport, /initial_size\.height/);
  assert.doesNotMatch(testSupport, /LogicalSize::new\(1280\.0,\s*800\.0\)/);
});

test("macOS creates the compositor surface on the AppKit main thread", () => {
  assert.match(compositor, /fn create_instance_and_surface/);
  assert.match(compositor, /run_on_main_thread/);
  assert.match(compositor, /create_surface\(surface_window\)/);
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
