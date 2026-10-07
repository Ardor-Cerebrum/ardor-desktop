import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { LocalAgentRuntimeManager, type LocalAgentProcess } from "./runtime-manager.js";
import type { LocalAgentJsonValue, LocalAgentRpcRequest, LocalAgentRuntimeScope } from "./protocol.js";

class FakeProcess extends EventEmitter implements LocalAgentProcess {
  readonly sent: Array<Record<string, LocalAgentJsonValue>> = [];
  constructor(readonly runtimeHome = tmpdir()) {
    super();
  }

  send(message: Record<string, LocalAgentJsonValue>): void {
    this.sent.push(message);
  }
  stop(): Promise<void> {
    this.emit("exit", 0);
    return Promise.resolve();
  }
  emitMessage(message: Record<string, LocalAgentJsonValue>): void {
    this.emit("message", message);
  }
  emitExit(code: number): void {
    this.emit("exit", code);
  }
}

const scope: LocalAgentRuntimeScope = { accountId: "auth0|user-1", workspaceId: "workspace-1" };

describe("LocalAgentRuntimeManager", () => {
  test("initializes once and reuses one runtime per account and Ardor workspace", async () => {
    const root = makeTempDirectory();
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      const connecting = manager.connect(scope);
      await Promise.resolve();
      const process = processes[0];
      expect(process?.sent[0]).toEqual({
        id: "ardor-initialize",
        method: "initialize",
        params: {
          clientInfo: { name: "ardor_desktop", title: "Ardor Desktop", version: "0.1" },
          capabilities: {
            experimentalApi: true,
            extensions: { "openai/form": {} },
            requestAttestation: false,
            optOutNotificationMethods: null,
          },
        },
      });
      initialize(process);
      const first = await connecting;
      expect(process?.sent[1]).toEqual({ method: "initialized" });
      await expect(manager.connect(scope)).resolves.toEqual(first);
      const secondConnecting = manager.connect({ ...scope, workspaceId: "workspace-2" });
      await Promise.resolve();
      initialize(processes[1]);
      await expect(secondConnecting).resolves.toMatchObject({
        generation: 1,
        state: "ready",
      });
      expect(processes).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an initialize handshake that does not describe the bundled runtime", async () => {
    const root = makeTempDirectory();
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      const connecting = manager.connect(scope);
      await Promise.resolve();
      const child = processes[0];
      child?.emitMessage({ id: "ardor-initialize", result: { userAgent: "codex_cli_rs/1.0.0" } });

      await expect(connecting).rejects.toThrow("Local Cerebrum initialize response is incompatible");
      expect(child?.sent.some((message) => message.method === "initialized")).toBe(false);
      expect(await manager.getStatus(scope)).toMatchObject({ state: "failed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the logical runtime identity stable across Desktop restarts", async () => {
    const root = makeTempDirectory();
    try {
      const createDefaultManager = (processes: FakeProcess[]) => new LocalAgentRuntimeManager({
        channel: "stage1",
        userDataPath: root,
        platform: process.platform,
        createProcess: (options) => {
          const child = new FakeProcess(options.runtimeHome);
          processes.push(child);
          return child;
        },
      });
      const firstProcesses: FakeProcess[] = [];
      const firstManager = createDefaultManager(firstProcesses);
      const firstRuntime = await connectReady(firstManager, firstProcesses);
      await firstManager.shutdownAll();

      const secondProcesses: FakeProcess[] = [];
      const secondManager = createDefaultManager(secondProcesses);
      const secondRuntime = await connectReady(secondManager, secondProcesses);

      expect(secondRuntime.runtimeId).toBe(firstRuntime.runtimeId);
      expect(secondRuntime.generation).toBe(1);
      await secondManager.shutdownAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reuses a durable accepted thread-start result after Desktop restarts", async () => {
    const root = makeTempDirectory();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    try {
      const processes: FakeProcess[] = [];
      const firstManager = createManager(root, processes);
      firstManager.authorizeProjectFolder(scope, projectRoot);
      const firstRuntime = await connectReady(firstManager, processes);
      const request = { id: 1, method: "thread/start", params: { cwd: projectRoot } };
      const first = firstManager.request(firstRuntime.runtimeId, firstRuntime.generation, request, { cwd: projectRoot }, "draft:v1:thread");
      processes[0]?.emitMessage({ id: 1, result: { thread: { id: "durable-thread" } } });
      await expect(first).resolves.toEqual({ thread: { id: "durable-thread" } });
      expect(firstManager.getOperationOutcome(
        firstRuntime.runtimeId,
        firstRuntime.generation,
        scope,
        "draft:v1:thread",
      )).toEqual({ status: "accepted", response: { thread: { id: "durable-thread" } } });
      await firstManager.shutdownAll();

      const nextManager = createManager(root, processes);
      const nextRuntime = await connectReady(nextManager, processes);
      await expect(nextManager.request(
        nextRuntime.runtimeId,
        nextRuntime.generation,
        request,
        { cwd: projectRoot },
        "draft:v1:thread",
      )).resolves.toEqual({ thread: { id: "durable-thread" } });
      expect(processes[1]?.sent.filter((message) => message.method === "thread/start")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not replay a durable thread-start with an unknown outcome after Desktop restarts", async () => {
    const root = makeTempDirectory();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    try {
      const processes: FakeProcess[] = [];
      const firstManager = createManager(root, processes);
      firstManager.authorizeProjectFolder(scope, projectRoot);
      const firstRuntime = await connectReady(firstManager, processes);
      const request = { id: 1, method: "thread/start", params: { cwd: projectRoot } };
      const pending = firstManager.request(firstRuntime.runtimeId, firstRuntime.generation, request, { cwd: projectRoot }, "draft:unknown:thread");
      processes[0]?.emitExit(1);
      await expect(pending).rejects.toThrow("Local Cerebrum runtime stopped.");
      expect(firstManager.getOperationOutcome(
        firstRuntime.runtimeId,
        firstRuntime.generation,
        scope,
        "draft:unknown:thread",
      )).toEqual({ status: "outcome-unknown" });
      await firstManager.shutdownAll();

      const nextProcesses: FakeProcess[] = [];
      const nextManager = createManager(root, nextProcesses);
      const nextRuntime = await connectReady(nextManager, nextProcesses);
      await expect(nextManager.request(
        nextRuntime.runtimeId,
        nextRuntime.generation,
        request,
        { cwd: projectRoot },
        "draft:unknown:thread",
      )).rejects.toThrow("previous operation outcome is unknown");
      expect(nextProcesses[0]?.sent.filter((message) => message.method === "thread/start")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps a Cerebrum RPC error unknown and blocks duplicate thread/start", async () => {
    const root = makeTempDirectory();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    try {
      const firstProcesses: FakeProcess[] = [];
      const firstManager = createManager(root, firstProcesses);
      firstManager.authorizeProjectFolder(scope, projectRoot);
      const firstRuntime = await connectReady(firstManager, firstProcesses);
      const request = { id: 1, method: "thread/start", params: { cwd: projectRoot } };
      const rejected = firstManager.request(firstRuntime.runtimeId, firstRuntime.generation, request, { cwd: projectRoot }, "draft:rejected:thread");
      firstProcesses[0]?.emitMessage({ id: 1, error: { code: -32602, message: "invalid model" } });
      await expect(rejected).rejects.toThrow("invalid model");
      expect(firstManager.getOperationOutcome(
        firstRuntime.runtimeId,
        firstRuntime.generation,
        scope,
        "draft:rejected:thread",
      )).toEqual({ status: "outcome-unknown" });
      await firstManager.shutdownAll();

      const nextProcesses: FakeProcess[] = [];
      const nextManager = createManager(root, nextProcesses);
      const nextRuntime = await connectReady(nextManager, nextProcesses);
      await expect(nextManager.request(
        nextRuntime.runtimeId,
        nextRuntime.generation,
        request,
        { cwd: projectRoot },
        "draft:rejected:thread",
      )).rejects.toThrow("previous operation outcome is unknown");
      expect(nextProcesses[0]?.sent.filter((message) => message.method === "thread/start")).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes typed MCP settings privately and never returns environment values to the renderer", async () => {
    const root = makeTempDirectory();
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      const runtime = await connectReady(manager, processes);
      const saving = manager.saveMcpServer(runtime.runtimeId, runtime.generation, scope, {
        name: "local-notes",
        command: "node",
        args: ["server.mjs"],
        environment: { API_TOKEN: "secret-value" },
        enabled: true,
      });
      const write = processes[0]?.sent.at(-1);
      expect(write).toMatchObject({
        method: "config/batchWrite",
        params: {
          edits: [{
            keyPath: "mcp_servers",
            mergeStrategy: "replace",
            value: {
              "local-notes": { command: "node", args: ["server.mjs"], env: { API_TOKEN: "secret-value" }, enabled: true },
            },
          }],
        },
      });
      if (typeof write?.id !== "string") throw new Error("MCP config write id is missing");
      processes[0]?.emitMessage({ id: write.id, result: { status: "ok", version: "1", filePath: "config.toml" } });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const reload = processes[0]?.sent.at(-1);
      expect(reload?.method).toBe("config/mcpServer/reload");
      if (typeof reload?.id !== "string") throw new Error("MCP reload id is missing");
      processes[0]?.emitMessage({ id: reload.id, result: {} });
      const saved = await saving;
      expect(saved).toEqual([{
        name: "local-notes",
        command: "node",
        args: ["server.mjs"],
        environmentKeys: ["API_TOKEN"],
        enabled: true,
      }]);
      expect(JSON.stringify(saved)).not.toContain("secret-value");
      expect(manager.listMcpServers(runtime.runtimeId, runtime.generation, scope)).toEqual(saved);
      expect(() => manager.listMcpServers(
        runtime.runtimeId,
        runtime.generation,
        { ...scope, workspaceId: "other-workspace" },
      )).toThrow("do not belong to this runtime scope");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stops only runtimes owned by a logged-out account and allows them to resume", async () => {
    const root = makeTempDirectory();
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      const otherScope = { ...scope, accountId: "auth0|user-2", workspaceId: "workspace-2" };

      const firstConnecting = manager.connect(scope);
      await Promise.resolve();
      initialize(processes[0]);
      const firstRuntime = await firstConnecting;
      const otherConnecting = manager.connect(otherScope);
      await Promise.resolve();
      initialize(processes[1]);
      await otherConnecting;

      await manager.stopAccount(scope.accountId);

      expect(await manager.getStatus(scope)).toMatchObject({ state: "stopped", runtimeId: firstRuntime.runtimeId });
      expect(await manager.getStatus(otherScope)).toMatchObject({ state: "ready" });

      const resumed = manager.connect(scope);
      await Promise.resolve();
      initialize(processes[2]);
      await expect(resumed).resolves.toMatchObject({ runtimeId: firstRuntime.runtimeId, generation: 2, state: "ready" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not orphan a process when logout races runtime startup", async () => {
    const root = makeTempDirectory();
    try {
      let releaseSpawn: (process: LocalAgentProcess) => void = () => {
        throw new Error("runtime process was not waiting to start");
      };
      const processCreation = new Promise<LocalAgentProcess>((resolve) => {
        releaseSpawn = resolve;
      });
      const manager = new LocalAgentRuntimeManager({
        channel: "stage1",
        userDataPath: root,
        platform: process.platform,
        createProcess: () => processCreation,
      });
      const connecting = manager.connect(scope);
      await Promise.resolve();
      const stopping = manager.stopAccount(scope.accountId);
      const child = new FakeProcess();
      releaseSpawn(child);

      await expect(connecting).rejects.toThrow("Local Cerebrum runtime changed during initialization.");
      await stopping;

      expect(child.sent).toEqual([]);
      expect(await manager.getStatus(scope)).toMatchObject({ state: "stopped", generation: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows expanded access only after an explicit per-thread choice and resets it when the process fails", async () => {
    const root = makeTempDirectory();
    const projectRoot = join(root, "project");
    mkdirSync(projectRoot);
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      manager.authorizeProjectFolder(scope, projectRoot);
      const runtime = await connectReady(manager, processes);
      const start = manager.request(runtime.runtimeId, runtime.generation, {
        id: 1,
        method: "thread/start",
        params: { cwd: projectRoot },
      }, { cwd: projectRoot });
      processes[0]?.emitMessage({ id: 1, result: { thread: { id: "thread-access" } } });
      await start;

      expect(manager.getThreadAccess(runtime.runtimeId, runtime.generation, scope, "thread-access")).toEqual({
        expanded: false,
      });
      expect(manager.setThreadAccess(runtime.runtimeId, runtime.generation, scope, "thread-access", true)).toEqual({
        expanded: true,
      });
      expect(() => manager.setThreadAccess(
        runtime.runtimeId,
        runtime.generation,
        { ...scope, workspaceId: "another-workspace" },
        "thread-access",
        true,
      )).toThrow("not owned by this local runtime");
      const expandedTurn = manager.request(runtime.runtimeId, runtime.generation, {
        id: 2,
        method: "turn/start",
        params: { threadId: "thread-access", input: [] },
      }, { cwd: projectRoot, threadId: "thread-access" });
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 2,
        method: "turn/start",
        params: {
          threadId: "thread-access",
          input: [],
          cwd: projectRoot,
          runtimeWorkspaceRoots: [projectRoot],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      });
      processes[0]?.emitMessage({ id: 2, result: { turn: { id: "turn-access", items: [] } } });
      await expandedTurn;

      const queuedStart = manager.request(runtime.runtimeId, runtime.generation, {
        id: 3,
        method: "thread/queue/start",
        params: { threadId: "thread-access" },
      }, { cwd: projectRoot, threadId: "thread-access" });
      const profileUpdate = processes[0]?.sent.at(-1);
      expect(profileUpdate).toMatchObject({
        method: "thread/settings/update",
        params: {
          threadId: "thread-access",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      });
      if (typeof profileUpdate?.id !== "string") throw new Error("profile update id is missing");
      processes[0]?.emitMessage({ id: profileUpdate.id, result: { threadId: "thread-access" } });
      await Promise.resolve();
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 3,
        method: "thread/queue/start",
        params: { threadId: "thread-access" },
      });
      processes[0]?.emitMessage({ id: 3, result: { threadId: "thread-access" } });
      await queuedStart;

      expect(manager.setThreadAccess(runtime.runtimeId, runtime.generation, scope, "thread-access", false)).toEqual({
        expanded: false,
      });

      processes[0]?.emitExit(1);
      expect(manager.getThreadAccess(runtime.runtimeId, runtime.generation, scope, "thread-access")).toEqual({
        expanded: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rebinds an owned chat to a newly selected project folder when its saved folder is missing", async () => {
    const root = makeTempDirectory();
    const originalProject = join(root, "moved-project");
    const replacementProject = join(root, "restored-project");
    mkdirSync(originalProject);
    mkdirSync(replacementProject);
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      manager.authorizeProjectFolder(scope, originalProject);
      manager.authorizeProjectFolder(scope, replacementProject);
      const runtime = await connectReady(manager, processes);
      const start = manager.request(runtime.runtimeId, runtime.generation, {
        id: 1,
        method: "thread/start",
        params: { cwd: originalProject },
      }, { cwd: originalProject });
      processes[0]?.emitMessage({ id: 1, result: { thread: { id: "thread-moved" } } });
      await start;
      rmSync(originalProject, { recursive: true, force: true });

      expect(manager.rebindThreadProjectFolder(
        runtime.runtimeId,
        runtime.generation,
        scope,
        "thread-moved",
        replacementProject,
      )).toEqual({ cwd: replacementProject });
      expect(manager.getThreadProjectContext(runtime.runtimeId, runtime.generation, "thread-moved")).toEqual({
        scope,
        cwd: replacementProject,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forces workspace-write approvals and binds each thread to its project directory", async () => {
    const root = makeTempDirectory();
    const projectRoot = join(root, "Проект с пробелом");
    mkdirSync(projectRoot);
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      expect(manager.authorizeProjectFolder(scope, projectRoot)).toBe(projectRoot);
      const runtime = await connectReady(manager, processes);
      await expect(manager.request(runtime.runtimeId, runtime.generation, {
        id: "renderer-initialize",
        method: "initialize",
        params: {},
      })).rejects.toThrow("handshake is owned by Desktop");
      const request: LocalAgentRpcRequest = {
        id: 1,
        method: "thread/start",
        params: {
          cwd: projectRoot,
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          modelProvider: "openai",
          config: { sandbox_mode: "danger-full-access" },
          dynamicTools: [{ name: "unapproved" }],
          selectedCapabilityRoots: [{ path: join(root, "outside") }],
        },
      };
      const pending = manager.request(runtime.runtimeId, runtime.generation, request, { cwd: projectRoot });
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 1,
        method: "thread/start",
        params: {
          cwd: projectRoot,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          runtimeWorkspaceRoots: [projectRoot],
          modelProvider: "ardor",
        },
      });
      processes[0]?.emitMessage({ id: 1, result: { thread: { id: "thread-1" } } });
      await pending;
      expect(manager.getThreadProjectContext(runtime.runtimeId, runtime.generation, "thread-1")).toEqual({
        scope,
        cwd: projectRoot,
      });

      const resume = manager.request(runtime.runtimeId, runtime.generation, {
        id: 5,
        method: "thread/resume",
        params: { threadId: "thread-1", cwd: join(root, "outside"), sandbox: "danger-full-access", approvalPolicy: "never", path: "C:\\outside.rollout" },
      }, { cwd: projectRoot, threadId: "thread-1" });
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 5,
        method: "thread/resume",
        params: {
          threadId: "thread-1",
          cwd: projectRoot,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          runtimeWorkspaceRoots: [projectRoot],
          modelProvider: "ardor",
        },
      });
      processes[0]?.emitMessage({ id: 5, result: { thread: { id: "thread-1" } } });
      await resume;

      const turnStart = manager.request(runtime.runtimeId, runtime.generation, {
        id: 6,
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [],
          cwd: join(root, "outside"),
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
          permissions: "danger-full-access",
          environments: [{ name: "cloud-computer" }],
          cyberAccessProgram: { name: "network" },
        },
      }, { cwd: projectRoot, threadId: "thread-1" });
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 6,
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [],
          cwd: projectRoot,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          runtimeWorkspaceRoots: [projectRoot],
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [projectRoot],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        },
      });
      processes[0]?.emitMessage({ id: 6, result: { turn: { id: "turn-1", items: [] } } });
      await turnStart;

      const steer = manager.request(runtime.runtimeId, runtime.generation, {
        id: 8,
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          input: [],
          cwd: join(root, "outside"),
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "dangerFullAccess" },
          permissions: "danger-full-access",
        },
      }, { cwd: projectRoot, threadId: "thread-1" });
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 8,
        method: "turn/steer",
        params: { threadId: "thread-1", input: [] },
      });
      processes[0]?.emitMessage({ id: 8, result: { turn: { id: "turn-1", items: [] } } });
      await steer;

      const updateSettings = manager.request(runtime.runtimeId, runtime.generation, {
        id: 7,
        method: "thread/settings/update",
        params: { threadId: "thread-1", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, permissions: "danger" },
      }, { cwd: projectRoot, threadId: "thread-1" });
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 7,
        method: "thread/settings/update",
        params: {
          threadId: "thread-1",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          cwd: projectRoot,
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [projectRoot],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        },
      });
      processes[0]?.emitMessage({ id: 7, result: { threadId: "thread-1" } });
      await updateSettings;

      await expect(manager.request(runtime.runtimeId, runtime.generation, {
        id: 2,
        method: "thread/resume",
        params: { threadId: "unknown-thread" },
      }, { cwd: projectRoot, threadId: "unknown-thread" })).rejects.toThrow("not owned by this local runtime");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires a folder selected by Desktop and binds file and command calls to one chat root", async () => {
    const root = makeTempDirectory();
    const projectRoot = join(root, "project");
    const outsideRoot = join(root, "outside");
    mkdirSync(projectRoot);
    mkdirSync(outsideRoot);
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      const runtime = await connectReady(manager, processes);
      await expect(manager.request(runtime.runtimeId, runtime.generation, {
        id: 1,
        method: "thread/start",
        params: { cwd: projectRoot },
      }, { cwd: projectRoot })).rejects.toThrow("Select the project folder from Desktop");

      manager.authorizeProjectFolder(scope, projectRoot);
      const start = manager.request(runtime.runtimeId, runtime.generation, {
        id: 2,
        method: "thread/start",
        params: { cwd: outsideRoot },
      }, { cwd: projectRoot });
      processes[0]?.emitMessage({ id: 2, result: { thread: { id: "thread-local" } } });
      await start;

      await expect(manager.request(runtime.runtimeId, runtime.generation, {
        id: 3,
        method: "fs/writeFile",
        params: { path: join(outsideRoot, "unsafe.txt"), data: "no" },
      }, { cwd: projectRoot, threadId: "thread-local" })).rejects.toThrow("outside this local chat's project folder");
      await expect(manager.request(runtime.runtimeId, runtime.generation, {
        id: 4,
        method: "command/exec",
        params: { command: ["echo", "unsafe"], cwd: outsideRoot },
      }, { cwd: outsideRoot, threadId: "thread-local" })).rejects.toThrow("does not match its saved location");

      const command = manager.request(runtime.runtimeId, runtime.generation, {
        id: 5,
        method: "command/exec",
        params: {
          command: ["git", "status"],
          cwd: outsideRoot,
          sandboxPolicy: { type: "dangerFullAccess" },
          permissionProfile: "unrestricted",
        },
      }, { cwd: projectRoot, threadId: "thread-local" });
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: 5,
        method: "command/exec",
        params: {
          command: ["git", "status"],
          cwd: projectRoot,
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [projectRoot],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        },
      });
      processes[0]?.emitMessage({ id: 5, result: { exitCode: 0, stdout: "ok", stderr: "" } });
      await command;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects writes through a dangling symbolic link in the project", async () => {
    const root = makeTempDirectory();
    const projectRoot = join(root, "project");
    const outsideRoot = join(root, "outside");
    mkdirSync(projectRoot);
    mkdirSync(outsideRoot);
    try {
      const danglingLink = join(projectRoot, "missing-target-link");
      if (process.platform === "win32") {
        symlinkSync(outsideRoot, danglingLink, "junction");
        rmSync(outsideRoot, { recursive: true, force: true });
      } else {
        symlinkSync(join(outsideRoot, "not-created"), danglingLink);
      }
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      manager.authorizeProjectFolder(scope, projectRoot);
      const runtime = await connectReady(manager, processes);
      const start = manager.request(runtime.runtimeId, runtime.generation, {
        id: 1,
        method: "thread/start",
        params: { cwd: projectRoot },
      }, { cwd: projectRoot }, "dangling-link-test:thread");
      processes[0]?.emitMessage({ id: 1, result: { thread: { id: "symlink-thread" } } });
      await start;

      await expect(manager.request(runtime.runtimeId, runtime.generation, {
        id: 2,
        method: "fs/writeFile",
        params: { path: danglingLink, data: "unsafe" },
      }, { cwd: projectRoot, threadId: "symlink-thread" })).rejects.toThrow("symbolic link with a missing target");
      expect(processes[0]?.sent.filter((message) => message.method === "fs/writeFile")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("forwards server requests and accepts each approval reply once", async () => {
    const root = makeTempDirectory();
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      const runtime = await connectReady(manager, processes);
      const events: unknown[] = [];
      manager.onEvent((event) => events.push(event));
      processes[0]?.emitMessage({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1" },
      });
      expect(events).toEqual([{
        runtimeId: runtime.runtimeId,
        generation: runtime.generation,
        message: {
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-1", turnId: "turn-1" },
        },
      }]);
      const replayedEvents: unknown[] = [];
      manager.onEvent((event) => replayedEvents.push(event));
      expect(replayedEvents).toEqual(events);
      await expect(Reflect.apply(manager.reply, manager, [
        runtime.runtimeId,
        runtime.generation,
        "approval-1",
        "another-thread",
        { decision: "accept" },
      ])).rejects.toThrow("does not belong to this chat");
      expect(processes[0]?.sent).toHaveLength(2);
      await manager.reply(runtime.runtimeId, runtime.generation, "approval-1", "thread-1", { decision: "accept" });
      const afterReplyEvents: unknown[] = [];
      manager.onEvent((event) => afterReplyEvents.push(event));
      expect(afterReplyEvents).toEqual([]);
      await expect(manager.reply(runtime.runtimeId, runtime.generation, "approval-1", "thread-1", { decision: "accept" }))
        .rejects.toThrow("not pending");
      expect(processes[0]?.sent.at(-1)).toEqual({
        id: "approval-1",
        result: { decision: "accept" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marks a crashed process failed without replaying an in-flight request", async () => {
    const root = makeTempDirectory();
    try {
      const processes: FakeProcess[] = [];
      const manager = createManager(root, processes);
      const runtime = await connectReady(manager, processes);
      const pending = manager.request(runtime.runtimeId, runtime.generation, {
        id: 50,
        method: "thread/list",
        params: {},
      });
      processes[0]?.emitExit(1);
      await expect(pending).rejects.toThrow("Local Cerebrum runtime stopped.");
      expect(await manager.getStatus(scope)).toMatchObject({ state: "failed", generation: 1 });
      expect(processes[0]?.sent.filter((message) => message.method === "thread/list")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createManager(root: string, processes: FakeProcess[]) {
  return new LocalAgentRuntimeManager({
    channel: "stage1",
    userDataPath: root,
    createRuntimeId: () => `runtime-${processes.length + 1}`,
    createProcess: (options) => {
      const process = new FakeProcess(options.runtimeHome);
      processes.push(process);
      return process;
    },
    platform: process.platform,
  });
}

async function connectReady(manager: LocalAgentRuntimeManager, processes: FakeProcess[]) {
  const connecting = manager.connect(scope);
  await Promise.resolve();
  initialize(processes.at(-1));
  return connecting;
}

function initialize(child: FakeProcess | undefined): void {
  if (!child) return;
  const platformFamily = process.platform === "win32" ? "windows" : "unix";
  const platformOs = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
  child.emitMessage({ id: "ardor-initialize", result: {
    userAgent: "codex_cli_rs/1.0.0",
    codexHome: child.runtimeHome,
    platformFamily,
    platformOs,
  } });
}

function makeTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "ardor-local-agent-"));
}
