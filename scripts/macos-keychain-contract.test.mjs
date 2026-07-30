import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtime = readFileSync(
  new URL("../src-tauri/vendor/tauri-runtime-cef/src/runtime.rs", import.meta.url),
  "utf8",
);

test("macOS mock keychain is enabled only for the stage1 bundle identifier", () => {
  assert.match(
    runtime,
    /const MACOS_STAGE1_IDENTIFIER: &str = "cloud\.ardor\.desktop\.stage1";/,
  );
  assert.match(
    runtime,
    /fn append_macos_stage1_keychain_arg\([\s\S]*?if identifier == MACOS_STAGE1_IDENTIFIER[\s\S]*?"--use-mock-keychain"/,
  );
  assert.match(
    runtime,
    /#\[cfg\(target_os = "macos"\)\]\s+append_macos_stage1_keychain_arg\(&mut command_line_args, &runtime_args\.identifier\);/,
  );
});
