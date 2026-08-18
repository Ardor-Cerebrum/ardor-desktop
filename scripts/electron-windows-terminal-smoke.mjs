import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;

export function terminalSmokeArguments() {
  return ["--ardor-terminal-smoke"];
}

export function terminalSmokeExecutablePath() {
  return resolve("out", "Ardor-win32-x64", "Ardor.exe");
}

export async function verifyWindowsTerminalSmoke(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Packaged Electron terminal smoke must run on Windows");
  }
  const executablePath = terminalSmokeExecutablePath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await access(executablePath);
  const child = spawn(executablePath, terminalSmokeArguments(), {
    env: { ...process.env, ...options.environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = captureOutput(child);
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let timedOut = false;
  let result;
  try {
    result = await Promise.race([
      exit,
      new Promise((resolveTimeout) => setTimeout(() => {
        timedOut = true;
        resolveTimeout({ code: null, signal: "TIMEOUT" });
      }, timeoutMs)),
    ]);
    if (timedOut || result.code !== 0) {
      throw new Error(formatTerminalSmokeFailure(executablePath, result, output, timeoutMs));
    }
  } finally {
    if (child.pid && child.exitCode === null) {
      const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (killed.status !== 0 && child.exitCode === null) child.kill();
      await Promise.race([exit.catch(() => undefined), new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))]);
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

export function formatTerminalSmokeFailure(executablePath, result, output, timeoutMs) {
  const details = [
    `Packaged Electron terminal smoke failed within ${timeoutMs} ms`,
    `Executable: ${executablePath}`,
    `Exit code: ${result.code ?? "none"}`,
    `Signal: ${result.signal ?? "none"}`,
  ];
  if (output.stderr.trim()) details.push(`stderr:\n${output.stderr.trim()}`);
  if (output.stdout.trim()) details.push(`stdout:\n${output.stdout.trim()}`);
  return details.join("\n");
}

async function main() {
  if (process.argv[2]) throw new Error("Usage: electron-windows-terminal-smoke.mjs");
  const executablePath = terminalSmokeExecutablePath();
  await verifyWindowsTerminalSmoke();
  console.log(`Packaged Electron terminal smoke passed: ${executablePath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
