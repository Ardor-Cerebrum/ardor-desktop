import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveCefBuildPaths, withCefBuildEnv } from "./cef-build-env.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultBuildDir = resolve(repoDir, "src-tauri");

test("CEF builds default to one shared cache and target directory", () => {
  assert.deepEqual(resolveCefBuildPaths({}), {
    cefPath: join(defaultBuildDir, "cef-cache"),
    targetDir: join(defaultBuildDir, "target"),
  });
  assert.equal(withCefBuildEnv({}).CARGO_INCREMENTAL, "0");
});

test("CEF build paths remain explicitly overridable", () => {
  const env = withCefBuildEnv({
    CEF_PATH: "/tmp/custom-cef",
    CARGO_TARGET_DIR: "/tmp/custom-target",
    CARGO_INCREMENTAL: "1",
    KEEP_ME: "yes",
  });

  assert.equal(env.CEF_PATH, "/tmp/custom-cef");
  assert.equal(env.CARGO_TARGET_DIR, "/tmp/custom-target");
  assert.equal(env.CARGO_INCREMENTAL, "1");
  assert.equal(env.KEEP_ME, "yes");
});
