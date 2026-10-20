import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { createLocalAgentStdioProcess } from "./stdio-process.js";
import type { LocalAgentProcess } from "./runtime-manager.js";

describe("Windows local runtime job lifetime", () => {
  for (const exitCode of [0, 2, 125]) {
    test.skipIf(process.platform !== "win32")(`accepts verified cleanup after natural runtime exit ${exitCode}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ardor-windows-job-"));
      const child = start(cwd, `process.exit(${exitCode});`);
      try {
        const code = await waitForExit(child);
        expect(code).toBe(exitCode === 125 ? 126 : exitCode);
        await expect(child.stop()).resolves.toBeUndefined();
        await expect(child.stop()).resolves.toBeUndefined();
      } finally {
        await child.stop();
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);
  }

  for (const mode of ["natural", "eof", "force"]) {
    test.skipIf(process.platform !== "win32")(`terminates descendants after ${mode} parent termination`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ardor-windows-job-"));
      const child = start(cwd, `
        const { spawn } = require('node:child_process');
        const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore', windowsHide: true,
        });
        descendant.unref();
        process.stdout.write(JSON.stringify({ parent: process.pid, descendant: descendant.pid }) + '\\n');
        process.stdin.resume();
        if (${JSON.stringify(mode)} === 'natural') process.exit(0);
        else if (${JSON.stringify(mode)} === 'eof') process.stdin.on('end', () => process.exit(0));
        else setInterval(() => {}, 1000);
      `);
      const exited = mode === "natural" ? waitForExit(child) : null;
      try {
        const pids = await waitForPids(child);
        if (mode === "natural") await exited;
        await expect(child.stop()).resolves.toBeUndefined();
        expect(isAlive(pids.parent)).toBe(false);
        expect(isAlive(pids.descendant)).toBe(false);
      } finally {
        await child.stop();
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test.skipIf(process.platform !== "win32")("preserves Unicode, spaces, quotes, empty and trailing-backslash arguments", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ardor-windows-job-"));
    const args = ["", "работа with spaces", 'a"b', "C:\\work path\\"];
    const child = start(cwd, "process.stdout.write(JSON.stringify({ args: process.argv.slice(1) }) + '\\n');", args);
    try {
      const message = await waitForMessage(child);
      expect(message).toEqual({ args });
      await child.stop();
    } finally {
      await child.stop();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

function start(cwd: string, code: string, args: string[] = []): LocalAgentProcess {
  const node = Bun.which("node");
  if (!node) throw new Error("Windows job fixtures require Node.js.");
  return createLocalAgentStdioProcess({
    command: node, args: ["-e", code, ...args], cwd, env: process.env, platform: "win32", stopTimeoutMs: 500,
  });
}

function waitForExit(child: LocalAgentProcess): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error("Windows job fixture did not exit."));
    }, 10_000);
    const onExit = (code: number) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveExit(code);
    };
    child.on("exit", onExit);
  });
}

async function waitForPids(child: LocalAgentProcess): Promise<{ parent: number; descendant: number }> {
  const value = await waitForMessage(child);
  if (typeof value !== "object" || value === null || !("parent" in value) || !("descendant" in value) ||
      typeof value.parent !== "number" || typeof value.descendant !== "number") throw new Error("Invalid PID fixture.");
  return { parent: value.parent, descendant: value.descendant };
}

function waitForMessage(child: LocalAgentProcess): Promise<unknown> {
  return new Promise((resolvePids, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Windows job fixture did not send a message."));
    }, 10_000);
    const onMessage = (value: unknown) => {
      cleanup();
      resolvePids(value);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Windows job fixture exited before its message."));
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
