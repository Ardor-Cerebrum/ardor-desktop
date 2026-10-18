import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { LocalAgentJsonValue } from "./protocol.js";
import { LocalAgentRuntimeManager, type LocalAgentProcess } from "./runtime-manager.js";
import { buildLocalAgentProviderConfig } from "./stdio-process.js";
import { verifyWindowsMxc, WINDOWS_MXC_UNAVAILABLE } from "./windows-mxc-readiness.js";

const roots: string[] = [];
const managers: LocalAgentRuntimeManager[] = [];
const scope = { accountId: "test-account", workspaceId: "test-workspace" };
type Rpc = Record<string, LocalAgentJsonValue>;
const configuration = () => ({ config: Bun.TOML.parse(buildLocalAgentProviderConfig(46123, "win32")) });

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdownAll()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Windows MXC private readiness", () => {
  test("requires a completed child under the workspace profile, not just ready", async () => {
    const sent: Array<{ method: string; params: Rpc; timeoutMs: number }> = [];
    const root = temporaryRoot();
    await verifyWindowsMxc({
      runtimeHome: root, timeoutMs: 2_000, systemRoot: "C:\\Windows",
      request: async (method, params, timeoutMs) => {
        sent.push({ method, params, timeoutMs });
        return response(method, params);
      },
    });
    expect(sent.map((entry) => entry.method)).toEqual([
      "config/read", "configRequirements/read", "windowsSandbox/readiness", "command/exec",
    ]);
    expect(sent.at(-1)?.params).toMatchObject({
      permissionProfile: "ardor-local-workspace", outputBytesCap: 4096,
      env: { ARDOR_DESKTOP_RELAY_TOKEN: null },
    });
    expect(sent.at(-1)?.params.command).toEqual([
      "C:\\Windows\\System32\\cmd.exe", "/d", "/c", expect.stringMatching(/^echo ardor-mxc-/),
    ]);
    expect(sent.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 2_000)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  test("accepts the pinned ConfigRequirements camelCase wire shape when MXC is permitted", async () => {
    await verifyWindowsMxc({
      runtimeHome: temporaryRoot(), timeoutMs: 2_000, systemRoot: "C:\\Windows",
      request: async (method, params) => method === "configRequirements/read" ? {
        requirements: {
          allowedWindowsSandboxImplementations: ["mxc"],
          allowedSandboxModes: ["workspace-write"],
          allowedPermissionProfiles: { "ardor-local-workspace": true },
          defaultPermissions: "ardor-local-workspace",
        },
      } : response(method, params),
    });
  });

  for (const [name, method, result] of [
    ["legacy backend", "config/read", { config: { windows: { sandbox: "unelevated" } } }],
    ["policy forbids MXC", "configRequirements/read", { requirements: { allowedWindowsSandboxImplementations: ["unelevated"] } }],
    ["policy allows no Windows backend", "configRequirements/read", { requirements: { allowedWindowsSandboxImplementations: [] } }],
    ["policy replaces permissions", "configRequirements/read", { requirements: { defaultPermissions: ":danger-full-access" } }],
    ["policy disallows workspace mode", "configRequirements/read", { requirements: { allowedSandboxModes: ["danger-full-access"] } }],
    ["policy disallows named profile", "configRequirements/read", { requirements: { allowedPermissionProfiles: { "ardor-local-workspace": false } } }],
    ["malformed constraints", "configRequirements/read", {}],
    ["setup required", "windowsSandbox/readiness", { status: "notConfigured" }],
    ["update required", "windowsSandbox/readiness", { status: "updateRequired" }],
    ["child launch failure", "command/exec", { exitCode: 1, stdout: "", stderr: "NTSTATUS private path" }],
    ["missing child proof", "command/exec", { exitCode: 0, stdout: "", stderr: "" }],
  ] satisfies Array<[string, string, LocalAgentJsonValue]>) {
    test(`fails closed: ${name}`, async () => {
      const sent: string[] = [];
      await expect(verifyWindowsMxc({
        runtimeHome: temporaryRoot(), timeoutMs: 2_000, systemRoot: "C:\\Windows",
        request: async (current, params) => {
          sent.push(current);
          return current === method ? result : response(current, params);
        },
      })).rejects.toThrow(WINDOWS_MXC_UNAVAILABLE);
      expect(sent.at(-1)).toBe(method);
    });
  }

  for (const error of ["native API unavailable", "deny-path capability missing", "network policy unsupported"]) {
    test(`normalizes backend error: ${error}`, async () => {
      await expect(verifyWindowsMxc({
        runtimeHome: temporaryRoot(), timeoutMs: 2_000, systemRoot: "C:\\Windows",
        request: async (method, params) => {
          if (method === "command/exec") throw new Error(error);
          return response(method, params);
        },
      })).rejects.toThrow(WINDOWS_MXC_UNAVAILABLE);
    });
  }
});

describe("Windows MXC execution gate", () => {
  test("does not expose internal readiness or config RPCs to the renderer", async () => {
    const h = harness();
    const connection = await h.manager.connect(scope);
    for (const method of ["config/read", "configRequirements/read", "windowsSandbox/readiness", "windowsSandbox/setupStart"]) {
      await expect(h.manager.request(connection.runtimeId, connection.generation, { id: method, method, params: {} })).rejects.toThrow();
    }
    expect(h.children[0]?.sent.map((entry) => entry.method)).toEqual(["initialize", "initialized"]);
  });

  test("auth changes during initialize do not publish a usable process early", async () => {
    const h = harness();
    const connecting = h.manager.connect(scope);
    h.manager.markNeedsAuth("runtime-mxc", 1);
    await expect(connecting).resolves.toMatchObject({ state: "needs-auth" });
    h.manager.markAuthReady("runtime-mxc", 1);
    expect(await h.manager.getStatus(scope)).toMatchObject({ state: "ready", lastError: null });
    expect(h.children[0]?.sent.map((entry) => entry.method)).toEqual(["initialize", "initialized"]);
  });

  test("history and model browsing need no probe; concurrent workloads share one check", async () => {
    const h = harness();
    const connection = await h.manager.connect(scope);
    await h.manager.request(connection.runtimeId, connection.generation, { id: "history", method: "thread/list", params: {} });
    expect(h.children[0]?.sent.map((entry) => entry.method)).toEqual(["initialize", "initialized", "thread/list"]);
    await Promise.all([1, 2].map((id) => h.manager.request(connection.runtimeId, connection.generation, {
      id, method: "mcpServerStatus/list", params: {},
    })));
    expect(h.children[0]?.sent.filter((entry) => entry.method === "command/exec")).toHaveLength(1);
    expect(h.children[0]?.sent.filter((entry) => entry.method === "mcpServerStatus/list")).toHaveLength(2);
  });

  for (const failure of ["command/exec", "configRequirements/read", "timeout"] as const) {
    test(`no user command, fallback or turn after ${failure}; history can reconnect`, async () => {
      const h = harness(failure);
      const connection = await h.manager.connect(scope);
      const pending = h.manager.request(connection.runtimeId, connection.generation, {
        id: "user-turn", method: "turn/start", params: {},
      });
      await expect(pending).rejects.toThrow(WINDOWS_MXC_UNAVAILABLE);
      expect(h.children[0]?.sent.some((entry) => entry.id === "user-turn")).toBe(false);
      expect(h.children[0]?.stopped).toBe(true);
      expect(await h.manager.getStatus(scope)).toMatchObject({ state: "failed", lastError: WINDOWS_MXC_UNAVAILABLE });
      const next = await h.manager.connect(scope);
      expect(next.generation).toBe(connection.generation + 1);
      await h.manager.request(next.runtimeId, next.generation, { id: "history", method: "thread/list", params: {} });
      expect(h.children[1]?.sent.map((entry) => entry.method)).toEqual(["initialize", "initialized", "thread/list"]);
    });
  }

  test("auth events cannot satisfy the sandbox gate", async () => {
    const h = harness("timeout");
    const connection = await h.manager.connect(scope);
    const pending = h.manager.request(connection.runtimeId, connection.generation, { id: "user-command", method: "command/exec", params: {} });
    h.manager.markNeedsAuth(connection.runtimeId, connection.generation);
    h.manager.markAuthReady(connection.runtimeId, connection.generation);
    await expect(pending).rejects.toThrow(WINDOWS_MXC_UNAVAILABLE);
    expect(h.children[0]?.sent.some((entry) => entry.id === "user-command")).toBe(false);
  });

  test("stop during a pending probe cannot revive or execute in a new generation", async () => {
    const h = harness("timeout");
    const connection = await h.manager.connect(scope);
    const pending = h.manager.request(connection.runtimeId, connection.generation, { id: "old-turn", method: "turn/start", params: {} });
    const rejected = expect(pending).rejects.toThrow();
    await h.manager.shutdownAll();
    const next = await h.manager.connect(scope);
    h.children[0]?.emit("message", { id: h.children[0]?.sent.at(-1)?.id, result: { status: "ready" } });
    await rejected;
    expect(await h.manager.getStatus(scope)).toMatchObject({ state: "ready", generation: next.generation });
    expect(h.children.every((child) => child.sent.every((entry) => entry.id !== "old-turn"))).toBe(true);
  });
});

class FakeProcess extends EventEmitter implements LocalAgentProcess {
  readonly sent: Rpc[] = [];
  stopped = false;
  constructor(private readonly runtimeHome: string, private readonly failure?: string) { super(); }
  send(message: Rpc): void {
    this.sent.push(message);
    if (!("id" in message)) return;
    if (this.failure === "timeout" && message.method === "config/read") return;
    queueMicrotask(() => {
      if (message.method === this.failure) {
        this.emit("message", { id: message.id, error: { code: -32000, message: "native capability unavailable" } });
      } else {
        this.emit("message", { id: message.id, result: message.method === "initialize" ? {
          userAgent: "codex_cli_rs/1.0.0", codexHome: this.runtimeHome, platformFamily: "windows", platformOs: "windows",
        } : response(String(message.method), typeof message.params === "object" && message.params !== null && !Array.isArray(message.params) ? message.params : {}) });
      }
    });
  }
  async stop(): Promise<void> { this.stopped = true; this.emit("exit", 0); }
}

function harness(failure?: string) {
  const children: FakeProcess[] = [];
  const manager = new LocalAgentRuntimeManager({
    channel: "stage1", userDataPath: temporaryRoot(), platform: "win32", systemRoot: "C:\\Windows", mxcReadinessTimeoutMs: 80,
    createRuntimeId: () => "runtime-mxc",
    createProcess: ({ runtimeHome }) => {
      const child = new FakeProcess(runtimeHome, failure);
      children.push(child);
      return child;
    },
  });
  managers.push(manager);
  return { manager, children };
}

function response(method: string, params: Rpc): LocalAgentJsonValue {
  if (method === "config/read") return configuration();
  if (method === "configRequirements/read") return { requirements: null };
  if (method === "windowsSandbox/readiness") return { status: "ready" };
  if (method === "command/exec") {
    const command = params.command;
    return { exitCode: 0, stdout: Array.isArray(command) ? `${String(command.at(-1)).replace(/^echo /, "")}\r\n` : "", stderr: "" };
  }
  return {};
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ardor-mxc-test-"));
  roots.push(root);
  return root;
}
