import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  formatTerminalSmokeFailure,
  terminalSmokeArguments,
  terminalSmokeExecutablePath,
} from "./electron-windows-terminal-smoke.mjs";

test("packaged terminal smoke starts the executable in terminal mode", () => {
  assert.deepEqual(terminalSmokeArguments(), ["--ardor-terminal-smoke"]);
  assert.equal(terminalSmokeExecutablePath(), resolve("out", "Ardor-win32-x64", "Ardor.exe"));
});

test("packaged terminal smoke failure includes captured process diagnostics", () => {
  const message = formatTerminalSmokeFailure(
    "C:\\Ardor Dev.exe",
    { code: 1, signal: null },
    { stderr: "node-pty failed", stdout: "" },
    30_000,
  );

  assert.match(message, /terminal smoke failed/i);
  assert.match(message, /node-pty failed/);
  assert.match(message, /Exit code: 1/);
});
