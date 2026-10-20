import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";

import {
  buildLocalAgentArguments,
  buildLocalAgentEnvironment,
  buildLocalAgentProviderConfig,
  createLocalAgentStdioProcess,
} from "./stdio-process.js";

describe("Local Cerebrum stdio process", () => {
  test.skipIf(process.platform === "win32")("kills a TERM-resistant descendant after its parent exits on EOF", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ardor-stdio-descendant-"));
    const descendantCode = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');";
    const parentCode = `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {
        env: {}, stdio: ['ignore', 'pipe', 'ignore'],
      });
      descendant.stdout.once('data', () => {
        descendant.stdout.destroy();
        descendant.unref();
        process.stdout.write(JSON.stringify({ parentPid: process.pid, descendantPid: descendant.pid }) + '\\n');
      });
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `;
    let parentPid: number | undefined;
    let descendantPid: number | undefined;
    const child = createLocalAgentStdioProcess({
      command: process.execPath, args: ["-e", parentCode], cwd, env: {}, platform: process.platform, stopTimeoutMs: 500,
    });
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error("descendant fixture timed out")), 2_000);
        child.on("message", (value) => {
          if (typeof value !== "object" || value === null || !("parentPid" in value) || !("descendantPid" in value)) return;
          if (typeof value.parentPid !== "number" || typeof value.descendantPid !== "number") return;
          parentPid = value.parentPid;
          descendantPid = value.descendantPid;
          clearTimeout(timer);
          resolveReady();
        });
      });
      // Some container PID 1 implementations leave killed orphans as zombies.
      // In that case stop must reject (unverified group), never report success.
      await child.stop().catch((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof Error && error.message).toBe("Local Cerebrum process group did not terminate.");
      });
      if (!descendantPid) throw new Error("Missing descendant PID.");
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(descendantPid)], { encoding: "utf8", timeout: 1_000 });
      expect(state.error).toBeUndefined();
      expect([0, 1]).toContain(state.status);
      expect(state.stdout.trim() === "" || state.stdout.trim().startsWith("Z")).toBe(true);
    } finally {
      await child.stop().catch(() => undefined);
      if (parentPid && parentPid > 1) {
        try { process.kill(-parentPid, "SIGKILL"); } catch { /* Fixture group already exited. */ }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("uses the supplied runtime catalog with a safely quoted absolute Windows path", () => {
    const path = "C:\\Ardor тест\\models.json";
    const config = buildLocalAgentProviderConfig(46123, "win32", path);
    expect(config).toContain(`model_catalog_json = ${JSON.stringify(path)}`);
    expect(config.indexOf("model_catalog_json")).toBeLessThan(config.indexOf("[model_providers.ardor]"));
    expect(() => buildLocalAgentProviderConfig(46123, "win32", "relative.json")).toThrow();
  });
  test("writes the Ardor Responses provider configuration without storing an Ardor token", () => {
    const config = buildLocalAgentProviderConfig(46123);
    expect(config).toContain('model_provider = "ardor"');
    expect(config).toContain('base_url = "http://127.0.0.1:46123/v1"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('env_key = "ARDOR_DESKTOP_RELAY_TOKEN"');
    expect(config).not.toContain("access-token");
    expect(config).toContain('default_permissions = "ardor-local-workspace"');
    expect(config).toContain('[permissions.ardor-local-workspace]\nextends = ":workspace"');
    expect(config).toContain('[permissions.ardor-local-workspace.filesystem]\n":tmpdir" = "read"');
    expect(config).toContain('":slash_tmp" = "read"');
    expect(config).toContain('[permissions.ardor-local-workspace.network]\nenabled = false');
  });

  test("selects MXC explicitly on Windows and leaves macOS on its native backend", () => {
    expect(buildLocalAgentProviderConfig(46123, "win32")).toContain('[windows]\nsandbox = "mxc"');
    expect(buildLocalAgentProviderConfig(46123, "darwin")).not.toContain("[windows]");
    expect(buildLocalAgentProviderConfig(46123, "linux")).not.toContain("[windows]");
    expect(buildLocalAgentArguments(["app-server"], "win32")).toEqual(["app-server", "-c", 'windows.sandbox="mxc"']);
    expect(buildLocalAgentArguments(["app-server"], "darwin")).toEqual(["app-server"]);
  });

  test("passes only runtime and non-secret operating environment variables", () => {
    const environment = buildLocalAgentEnvironment({
      PATH: "C:\\Windows\\System32;C:\\Tools",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      OPENAI_API_KEY: "user-key",
      AWS_SECRET_ACCESS_KEY: "user-secret",
      ARDOR_INTERNAL_ACCESS_TOKEN: "internal-token",
      CODEX_HOME: "C:\\Users\\user\\.codex",
    }, "C:\\Users\\user\\AppData\\Ardor\\local-cerebrum", "relay-token-only");
    expect(environment).toEqual({
      PATH: "C:\\Windows\\System32;C:\\Tools",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\Temp",
      CODEX_HOME: "C:\\Users\\user\\AppData\\Ardor\\local-cerebrum",
      ARDOR_DESKTOP_RELAY_TOKEN: "relay-token-only",
    });
  });

  test("copies allowlisted environment variables under canonical names", () => {
    const environment = buildLocalAgentEnvironment({
      SystemRoot: "C:\\Windows",
      path: "C:\\Windows\\System32",
    }, "C:\\Users\\user\\AppData\\Ardor\\local-cerebrum", "relay-token-only");

    expect(environment.SYSTEMROOT).toBe("C:\\Windows");
    expect(environment.PATH).toBe("C:\\Windows\\System32");
    expect(environment.SystemRoot).toBeUndefined();
    expect(environment.path).toBeUndefined();
  });

  test("uses newline-delimited JSON-RPC over stdio and exits on EOF", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ardor-stdio-rpc-"));
    const code = "process.stdin.setEncoding('utf8'); let buffer=''; process.stdin.on('data', chunk => { buffer += chunk; while (buffer.includes('\\n')) { const at=buffer.indexOf('\\n'); const line=buffer.slice(0,at); buffer=buffer.slice(at+1); const request=JSON.parse(line); process.stdout.write(JSON.stringify({id:request.id,result:{method:request.method}})+'\\n'); } });";
    try {
      const child = createLocalAgentStdioProcess({
        command: process.execPath,
        args: ["-e", code],
        cwd,
        env: { ...process.env },
        platform: process.platform,
        stopTimeoutMs: 1_000,
      });
      const message = new Promise<Record<string, unknown>>((resolveMessage, reject) => {
        const timer = setTimeout(() => reject(new Error("stdio response timed out")), 2_000);
        child.on("message", (value) => {
          clearTimeout(timer);
          if (typeof value === "object" && value !== null && !Array.isArray(value)) resolveMessage(value);
          else reject(new Error("stdio response was not an object"));
        });
      });
      child.send({ id: 3, method: "thread/list", params: {} });
      await expect(message).resolves.toEqual({ id: 3, result: { method: "thread/list" } });
      await child.stop();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("handles stdin errors when Cerebrum closes its input during a write", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ardor-stdio-write-error-"));
    const bundlePath = join(cwd, "stdio-process.mjs");
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./stdio-process.ts", import.meta.url))],
      outfile: bundlePath,
      write: false,
      target: "node",
      format: "esm",
    });
    expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true);
    const [bundle] = build.outputs;
    if (!bundle) throw new Error("Local Cerebrum stdio bundle was not generated.");
    writeFileSync(bundlePath, Buffer.from(await bundle.arrayBuffer()));

    const childCode = "process.stdout.write('{\"ready\":true}\\n'); process.stdin.once('data', () => { process.stdin.destroy(); setTimeout(() => process.exit(0), 250); });";
    const runnerCode = `
      import { createLocalAgentStdioProcess } from ${JSON.stringify(pathToFileURL(bundlePath).href)};

      const child = createLocalAgentStdioProcess({
        command: process.execPath,
        args: ["-e", ${JSON.stringify(childCode)}],
        cwd: ${JSON.stringify(cwd)},
        env: process.env,
        platform: process.platform,
        stopTimeoutMs: 100,
      });
      const ready = new Promise((resolve) => {
        child.on("message", (value) => {
          if (typeof value === "object" && value !== null && !Array.isArray(value) && value.ready === true) {
            resolve();
          }
        });
      });
      const exited = new Promise((resolve) => child.once("exit", resolve));
      await ready;
      child.send({ id: 1, method: "thread/list", params: {}, padding: "x".repeat(8 * 1024 * 1024) });
      const code = await exited;
      if (code !== 0 && code !== -1) process.exitCode = 2;
      await new Promise((resolve) => setTimeout(resolve, 50));
      console.log("handled stdin error", code);
    `;
    try {
      const outcome = spawnSync("node", ["--input-type=module", "-e", runnerCode], {
        cwd,
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(outcome.error).toBeUndefined();
      expect(outcome.status, outcome.stderr).toBe(0);
      expect(outcome.stdout).toMatch(/handled stdin error (?:-1|0)/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
