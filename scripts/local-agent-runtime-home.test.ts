import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeRuntimeHome } from "../electron/local-agent/runtime-manager.js";

test("runtime homes resolve directory aliases under the packaged Node runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "ardor-runtime-home-"));
  try {
    const home = join(root, "account-home");
    const otherHome = join(root, "other-account-home");
    const alias = join(root, "home-alias");
    mkdirSync(home);
    mkdirSync(otherHome);
    symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(normalizeRuntimeHome(alias, process.platform), normalizeRuntimeHome(home, process.platform));
    assert.notEqual(normalizeRuntimeHome(otherHome, process.platform), normalizeRuntimeHome(home, process.platform));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows short names and Rust extended paths identify the same runtime home", {
  skip: process.platform !== "win32",
}, (context) => {
  const root = mkdtempSync(join(tmpdir(), "ardor-runtime-home-"));
  try {
    const home = join(root, "runtime home with spaces", "account", "workspace");
    mkdirSync(home, { recursive: true });
    const longHome = realpathSync.native(home);
    // Expand a controlled temporary path through cmd's native short-name modifier.
    // An environment variable avoids embedding path characters in shell code.
    const shortHome = execFileSync("cmd.exe", [
      "/d", "/v:off", "/c", 'for %I in ("%ARDOR_TEST_RUNTIME_HOME%") do @echo %~sI',
    ], { encoding: "utf8", env: { ...process.env, ARDOR_TEST_RUNTIME_HOME: longHome } }).trim();
    assert.ok(shortHome.length > 0, "Windows did not return a runtime-home path");
    if (!/(?:^|[\\/])[^\\/]*~\d(?:[^\\/]*)(?:[\\/]|$)/.test(shortHome)) {
      context.skip("The temporary volume does not provide Windows 8.3 aliases.");
      return;
    }
    const extendedHome = longHome.startsWith("\\\\?\\") ? longHome : `\\\\?\\${longHome}`;
    assert.equal(normalizeRuntimeHome(shortHome, "win32"), normalizeRuntimeHome(longHome, "win32"));
    assert.equal(normalizeRuntimeHome(shortHome, "win32"), normalizeRuntimeHome(extendedHome, "win32"));
    context.diagnostic(`Node JS realpath preserves an 8.3 alias: ${realpathSync(shortHome) !== realpathSync.native(shortHome)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
