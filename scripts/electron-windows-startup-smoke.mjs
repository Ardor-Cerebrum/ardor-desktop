import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_STARTUP_WINDOW_MS = 5_000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;

export async function verifyWindowsStartup(executablePath, options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Electron Windows startup smoke must run on Windows");
  }

  const startupWindowMs = options.startupWindowMs ?? DEFAULT_STARTUP_WINDOW_MS;
  await access(executablePath);

  const child = spawn(executablePath, ["--enable-logging=stderr"], {
    env: { ...process.env, ...options.environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = captureOutput(child);
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let earlyExit;

  try {
    earlyExit = await Promise.race([
      exit,
      new Promise((resolveDelay) => setTimeout(() => resolveDelay(undefined), startupWindowMs)),
    ]);
    if (earlyExit) {
      throw new Error(formatEarlyExit(executablePath, earlyExit, output, startupWindowMs));
    }
  } finally {
    if (child.pid && child.exitCode === null) {
      const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (killed.status !== 0 && child.exitCode === null) {
        child.kill();
      }
      await Promise.race([
        exit.catch(() => undefined),
        new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
      ]);
    }
  }
}

function captureOutput(child) {
  const output = { stderr: "", stdout: "" };
  for (const streamName of ["stdout", "stderr"]) {
    child[streamName]?.setEncoding("utf8");
    child[streamName]?.on("data", (chunk) => {
      output[streamName] = `${output[streamName]}${chunk}`.slice(-MAX_CAPTURED_OUTPUT);
    });
  }
  return output;
}

function formatEarlyExit(executablePath, exit, output, startupWindowMs) {
  const details = [
    `Packaged Electron application exited before the ${startupWindowMs} ms startup window`,
    `Executable: ${executablePath}`,
    `Exit code: ${exit.code ?? "none"}`,
    `Signal: ${exit.signal ?? "none"}`,
  ];
  if (output.stderr.trim()) details.push(`stderr:\n${output.stderr.trim()}`);
  if (output.stdout.trim()) details.push(`stdout:\n${output.stdout.trim()}`);
  return details.join("\n");
}

async function main() {
  const executablePath = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Usage: electron-windows-startup-smoke.mjs <path-to-exe>");
  await verifyWindowsStartup(executablePath);
  console.log(`Packaged Electron startup smoke passed: ${executablePath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
