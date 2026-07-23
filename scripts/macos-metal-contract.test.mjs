import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");

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
