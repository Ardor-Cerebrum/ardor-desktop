import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalAgentRuntimeManager, normalizeRuntimeHome } from "../electron/local-agent/runtime-manager.js";
import type { LocalAgentJsonValue } from "../electron/local-agent/protocol.js";

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
    ], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
      env: { ...process.env, ARDOR_TEST_RUNTIME_HOME: longHome },
    }).trim();
    assert.ok(shortHome.length > 0, "Windows did not return a runtime-home path");
    assert.ok(existsSync(shortHome), "cmd did not return a valid path; do not treat quoting errors as missing 8.3 support");
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

test("project RPCs resolve native Windows aliases without changing saved chat identity", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ardor-project-case-"));
  const project = join(root, "Project with spaces");
  mkdirSync(project);
  const alias = process.platform === "win32" ? project.toUpperCase() : join(root, "project-alias");
  if (process.platform !== "win32") symlinkSync(project, alias, "dir");
  assert.ok(existsSync(alias), "The directory alias must identify the test project");
  const nativeProject = realpathSync.native(project);
  const scope = { accountId: "path-test-account", workspaceId: "path-test-workspace" };
  const children: PathTestProcess[] = [];
  const options = {
    channel: "stage1",
    userDataPath: root,
    platform: process.platform,
    createProcess: ({ runtimeHome }: { runtimeHome: string }) => {
      const child = new PathTestProcess(runtimeHome);
      children.push(child);
      return child;
    },
  };
  let manager = new LocalAgentRuntimeManager(options);
  try {
    manager.authorizeProjectFolder(scope, alias);
    const runtime = await manager.connect(scope);
    await manager.request(runtime.runtimeId, runtime.generation,
      { id: 1, method: "thread/start", params: {} }, { cwd: alias });
    const requestContext = { cwd: alias, threadId: "path-test-thread" };
    const savedContext = manager.getThreadProjectContext(runtime.runtimeId, runtime.generation, requestContext.threadId);
    const child = children[0]!;
    const start = child.sent.find((message) => message.method === "thread/start")!;
    assert.equal((start.params as Record<string, LocalAgentJsonValue>).cwd, nativeProject);
    assert.deepEqual((start.params as Record<string, LocalAgentJsonValue>).runtimeWorkspaceRoots, [nativeProject]);

    for (const method of ["command/exec", "turn/start", "thread/settings/update", "thread/resume"] as const) {
      await manager.request(runtime.runtimeId, runtime.generation, {
        id: method,
        method,
        params: method === "command/exec"
          ? { command: ["cmd.exe", "/c", "echo", "test"], permissionProfile: "unrestricted" }
          : { threadId: requestContext.threadId, input: [] },
      }, requestContext);
      const params = child.sent.at(-1)!.params as Record<string, LocalAgentJsonValue>;
      assert.equal(params.cwd, nativeProject, `${method} must match the native writable root`);
      if (method === "command/exec") assert.equal(params.permissionProfile, "ardor-local-workspace");
    }
    await manager.request(runtime.runtimeId, runtime.generation,
      { id: "fs", method: "fs/readFile", params: { path: join(alias, "file.txt") } }, requestContext);
    const fileParams = child.sent.at(-1)!.params as Record<string, LocalAgentJsonValue>;
    assert.equal((fileParams.sandboxContext as Record<string, LocalAgentJsonValue>).cwd, nativeProject);
    await assert.rejects(manager.request(runtime.runtimeId, runtime.generation,
      { id: "outside", method: "fs/readFile", params: { path: join(root, "outside.txt") } }, requestContext),
    /outside this local chat's project folder/);

    await manager.shutdownAll();
    manager = new LocalAgentRuntimeManager(options);
    const resumedRuntime = await manager.connect(scope);
    assert.deepEqual(manager.getThreadProjectContext(resumedRuntime.runtimeId, resumedRuntime.generation, requestContext.threadId), savedContext);
    await manager.request(resumedRuntime.runtimeId, resumedRuntime.generation,
      { id: "resume", method: "thread/resume", params: { threadId: requestContext.threadId } }, requestContext);
    assert.equal((children.at(-1)!.sent.at(-1)!.params as Record<string, LocalAgentJsonValue>).cwd, nativeProject);
    context.diagnostic(`Node JS project realpath differs from native: ${realpathSync(alias) !== nativeProject}`);
  } finally {
    await manager.shutdownAll();
    rmSync(root, { recursive: true, force: true });
  }
});

class PathTestProcess extends EventEmitter {
  readonly sent: Array<Record<string, LocalAgentJsonValue>> = [];

  constructor(private readonly runtimeHome: string) { super(); }

  send(message: Record<string, LocalAgentJsonValue>): void {
    this.sent.push(message);
    if (message.id === undefined) return;
    const result = message.method === "initialize"
      ? {
        userAgent: "codex_cli_rs/path-test", codexHome: this.runtimeHome,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform,
      }
      : message.method === "thread/start" || message.method === "thread/resume"
        ? { thread: { id: "path-test-thread" } }
        : {};
    queueMicrotask(() => this.emit("message", { id: message.id, result }));
  }

  async stop(): Promise<void> { this.emit("exit", 0); }
}
