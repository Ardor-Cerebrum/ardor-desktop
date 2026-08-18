import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { spawn } = require("node-pty");

function waitForOutput(read, marker, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (read().includes(marker)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for native terminal marker: ${marker}; output=${JSON.stringify(read())}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("node-pty provides a real TTY and forwards raw arrow-key bytes", {
  skip: process.platform === "win32" ? "POSIX raw-mode fixture" : false,
  timeout: 10_000,
}, async (context) => {
  const fixture = fileURLToPath(new URL("./fixtures/raw-mode.py", import.meta.url));
  const pty = spawn("/bin/bash", ["-l"], {
    cols: 80,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
    name: "xterm-256color",
    rows: 24,
  });
  let output = "";
  const dataDisposable = pty.onData((data) => {
    output += data;
  });
  const exitDisposable = pty.onExit(() => undefined);
  context.after(() => {
    dataDisposable.dispose();
    exitDisposable.dispose();
    try {
      pty.kill();
    } catch {
      // The shell may already have exited after the assertions completed.
    }
  });

  pty.write(`python3 ${JSON.stringify(fixture)}\r`);
  await waitForOutput(() => output, "__RAW_READY__");
  pty.write("\u001b[A");
  await waitForOutput(() => output, "__RAW__1b5b41");

  assert.match(output, /__TTY__1/);
  assert.match(output, /__RAW__1b5b41/);
});

test("node-pty loads, spawns, resizes, and exits cleanly", { timeout: 10_000 }, async (context) => {
  const windows = process.platform === "win32";
  const shell = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/bash";
  const pty = spawn(shell, windows ? [] : ["--noprofile", "--norc"], {
    cols: 80,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
    name: "xterm-256color",
    rows: 24,
  });
  let output = "";
  let exited = false;
  const dataDisposable = pty.onData((data) => {
    output += data;
  });
  const exitPromise = new Promise((resolve) => {
    pty.onExit((event) => {
      exited = true;
      resolve(event);
    });
  });
  context.after(() => {
    dataDisposable.dispose();
    if (!exited) {
      try {
        pty.kill();
      } catch {
        // The PTY may have exited between checking and cleanup.
      }
    }
  });

  assert.doesNotThrow(() => pty.resize(100, 30));
  pty.write(windows ? "echo __PTY_SMOKE__\r" : "printf '__PTY_SMOKE__\\n'\r");
  await waitForOutput(() => output, "__PTY_SMOKE__");
  pty.write("exit\r");
  const result = await exitPromise;

  assert.equal(result.exitCode, 0);
});
