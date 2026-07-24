import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

assert.equal(process.platform, "darwin", "WindowServer tests require macOS");
assert.equal(process.arch, "arm64", "WindowServer tests require Apple Silicon");

const result = spawnSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--features",
    "metal-integration-tests",
    "--test",
    "macos_metal_windowserver",
  ],
  {
    env: {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: "13.0",
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
