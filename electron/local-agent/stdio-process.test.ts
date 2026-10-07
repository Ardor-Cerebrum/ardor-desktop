import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  buildLocalAgentEnvironment,
  buildLocalAgentProviderConfig,
  createLocalAgentStdioProcess,
} from "./stdio-process.js";

describe("Local Cerebrum stdio process", () => {
  test("writes the Ardor Responses provider configuration without storing an Ardor token", () => {
    const config = buildLocalAgentProviderConfig(46123);
    expect(config).toContain('model_provider = "ardor"');
    expect(config).toContain('base_url = "http://127.0.0.1:46123/v1"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('env_key = "ARDOR_DESKTOP_RELAY_TOKEN"');
    expect(config).not.toContain("access-token");
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
});
