import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  parseLocalAgentRpcRequest,
  parseLocalAgentJsonObject,
  parseLocalAgentRequestContext,
  parseLocalAgentRuntimeScope,
  resolveLocalProjectPath,
  type LocalAgentJsonValue,
  type LocalAgentRpcRequest,
  type LocalAgentRequestContext,
  type LocalAgentRuntimeScope,
} from "./protocol.js";

export type LocalAgentRuntimeState = "starting" | "ready" | "needs-auth" | "failed" | "stopping" | "stopped";

export interface LocalAgentRuntimeHandle {
  readonly runtimeId: string;
  readonly generation: number;
  readonly state: LocalAgentRuntimeState;
}

export interface LocalAgentRuntimeStatus extends LocalAgentRuntimeHandle {
  readonly lastError: string | null;
}

export interface LocalAgentMcpServerDefinition {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly enabled: boolean;
}

export interface LocalAgentMcpServerSummary {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environmentKeys: readonly string[];
  readonly enabled: boolean;
}

export type LocalAgentOperationOutcome =
  | { readonly status: "not-started" }
  | { readonly status: "outcome-unknown" }
  | { readonly status: "accepted"; readonly response: LocalAgentJsonValue };

export interface LocalAgentEvent {
  readonly runtimeId: string;
  readonly generation: number;
  readonly message: Record<string, LocalAgentJsonValue>;
}

export interface LocalAgentProcess {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
  removeListener(event: "exit", listener: (code: number) => void): this;
  send(message: Record<string, LocalAgentJsonValue>): void;
  stop(): Promise<void>;
}

export interface LocalAgentProcessOptions {
  readonly channel: string;
  readonly generation: number;
  readonly runtimeHome: string;
  readonly runtimeId: string;
  readonly scope: LocalAgentRuntimeScope;
}

export interface LocalAgentRuntimeManagerOptions {
  readonly channel: string;
  readonly userDataPath: string;
  readonly platform: NodeJS.Platform;
  readonly createProcess: (options: LocalAgentProcessOptions) => LocalAgentProcess | Promise<LocalAgentProcess>;
  readonly createRuntimeId?: () => string;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

interface PendingRpcRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (result: LocalAgentJsonValue) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class LocalAgentRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAgentRpcError";
  }
}

class LocalAgentRequestNotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalAgentRequestNotSentError";
  }
}

interface DurableOperationReceipt {
  readonly fingerprint: string;
  readonly operationId: string;
  readonly response?: LocalAgentJsonValue;
  readonly schemaVersion: 1;
  readonly status: "accepted" | "not-started" | "outcome-unknown";
}

interface PendingDurableOperation {
  readonly fingerprint: string;
  readonly promise: Promise<LocalAgentJsonValue>;
}

interface AppServerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: Record<string, LocalAgentJsonValue>;
}

interface RuntimeRecord {
  readonly dataHome: string;
  readonly key: string;
  readonly pendingRpc: Map<string | number, PendingRpcRequest>;
  readonly pendingOperations: Map<string, PendingDurableOperation>;
  readonly pendingServerRequests: Map<string | number, Record<string, LocalAgentJsonValue>>;
  readonly mcpServers: Map<string, LocalAgentMcpServerDefinition>;
  readonly scope: LocalAgentRuntimeScope;
  readonly selectedProjectRoots: Set<string>;
  readonly threadRoots: Map<string, string>;
  readonly expandedAccessThreads: Set<string>;
  readonly pendingTurnAccess: Map<string, boolean>;
  readonly activeTurnAccess: Map<string, boolean>;
  generation: number;
  lastError: string | null;
  process: LocalAgentProcess | null;
  processExitListener: ((code: number) => void) | null;
  processMessageListener: ((message: unknown) => void) | null;
  runtimeId: string;
  startPromise: Promise<LocalAgentRuntimeHandle> | null;
  stopPromise: Promise<void> | null;
  state: LocalAgentRuntimeState;
  stopping: boolean;
}

const initializeParams: Record<string, LocalAgentJsonValue> = {
  clientInfo: { name: "ardor_desktop", title: "Ardor Desktop", version: "0.1" },
  capabilities: {
    experimentalApi: true,
    extensions: { "openai/form": {} },
    requestAttestation: false,
    optOutNotificationMethods: null,
  },
};

const threadScopedMethods = new Set([
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/rollback",
  "thread/compact/start",
  "thread/settings/update",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear",
  "thread/queue/add",
  "thread/queue/list",
  "thread/queue/update",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/queue/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/revert",
  "thread/inject_items",
]);
const modelExecutionMethods = new Set(["turn/start", "turn/steer", "thread/queue/start"]);

export class LocalAgentRuntimeManager {
  private readonly channel: string;
  private readonly createProcess: LocalAgentRuntimeManagerOptions["createProcess"];
  private readonly createRuntimeId: LocalAgentRuntimeManagerOptions["createRuntimeId"];
  private readonly handshakeTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly requestTimeoutMs: number;
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly userDataPath: string;
  private readonly eventListeners = new Set<(event: LocalAgentEvent) => void>();

  constructor(options: LocalAgentRuntimeManagerOptions) {
    this.channel = parseChannel(options.channel);
    this.userDataPath = options.userDataPath;
    this.platform = options.platform;
    this.createProcess = options.createProcess;
    this.createRuntimeId = options.createRuntimeId;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (this.handshakeTimeoutMs < 1 || this.requestTimeoutMs < 1) {
      throw new RangeError("local agent timeouts must be positive");
    }
  }

  async getStatus(scopeValue: unknown): Promise<LocalAgentRuntimeStatus> {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.runtimes.get(this.getScopeKey(scope));
    if (runtime) return this.toStatus(runtime);
    return { runtimeId: "", generation: 0, state: "stopped", lastError: null };
  }

  getOperationOutcome(
    runtimeId: string,
    generation: number,
    scopeValue: unknown,
    operationIdValue: unknown,
  ): LocalAgentOperationOutcome {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.findRuntime(runtimeId, generation);
    if (!runtime || runtime.key !== this.getScopeKey(scope)) {
      throw new Error("Local operation does not belong to this runtime scope.");
    }
    const operationId = parseOptionalOperationId(operationIdValue);
    if (!operationId) {
      throw new TypeError("Local operation identity is required.");
    }
    const receipt = this.readOperationReceipt(this.operationReceiptPath(runtime, operationId), operationId);
    if (!receipt || receipt.status === "not-started") {
      return { status: "not-started" };
    }
    if (receipt.status === "outcome-unknown") {
      return { status: "outcome-unknown" };
    }
    if (receipt.response === undefined) {
      throw new Error("Durable local operation receipt is invalid; refusing to recover it.");
    }
    return { status: "accepted", response: receipt.response };
  }

  authorizeProjectFolder(scopeValue: unknown, pathValue: unknown): string {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.getOrCreateRuntime(scope);
    const projectRoot = this.resolveProjectRoot(pathValue);
    runtime.selectedProjectRoots.add(projectRoot);
    this.persistProjectRoots(runtime);
    return projectRoot;
  }

  getThreadProjectContext(
    runtimeId: string,
    generation: number,
    threadId: string,
  ): { readonly scope: LocalAgentRuntimeScope; readonly cwd: string } | null {
    const runtime = this.findRuntime(runtimeId, generation);
    const cwd = runtime?.threadRoots.get(threadId);
    if (!runtime || !cwd) return null;
    return { scope: runtime.scope, cwd };
  }

  getThreadAccess(
    runtimeId: string,
    generation: number,
    scopeValue: unknown,
    threadId: string,
  ): { readonly expanded: boolean } {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.findRuntime(runtimeId, generation);
    if (!runtime || runtime.key !== this.getScopeKey(scope) ||
        (runtime.state !== "ready" && runtime.state !== "needs-auth") || !runtime.process ||
        !runtime.threadRoots.has(threadId)) {
      return { expanded: false };
    }
    return { expanded: runtime.expandedAccessThreads.has(threadId) };
  }

  setThreadAccess(
    runtimeId: string,
    generation: number,
    scopeValue: unknown,
    threadId: string,
    expanded: boolean,
  ): { readonly expanded: boolean } {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.requireReadyRuntime(runtimeId, generation);
    if (runtime.key !== this.getScopeKey(scope) || !runtime.threadRoots.has(threadId)) {
      throw new Error("Thread is not owned by this local runtime.");
    }
    const projectRoot = runtime.threadRoots.get(threadId);
    if (!projectRoot || !existsSync(projectRoot) || !this.isDirectory(projectRoot)) {
      throw new Error("Project folder is missing. Choose its location to continue.");
    }
    if (expanded) runtime.expandedAccessThreads.add(threadId);
    else runtime.expandedAccessThreads.delete(threadId);
    return { expanded };
  }

  getThreadProjectFolder(
    runtimeId: string,
    generation: number,
    scopeValue: unknown,
    threadId: string,
  ): { readonly cwd: string; readonly exists: boolean } | null {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.findRuntime(runtimeId, generation);
    if (!runtime || runtime.key !== this.getScopeKey(scope)) return null;
    const cwd = runtime.threadRoots.get(threadId);
    if (!cwd) return null;
    return { cwd, exists: existsSync(cwd) && this.isDirectory(cwd) };
  }

  rebindThreadProjectFolder(
    runtimeId: string,
    generation: number,
    scopeValue: unknown,
    threadId: string,
    pathValue: unknown,
  ): { readonly cwd: string } {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.requireReadyRuntime(runtimeId, generation);
    if (runtime.key !== this.getScopeKey(scope) || !runtime.threadRoots.has(threadId)) {
      throw new Error("Thread is not owned by this local runtime.");
    }
    const projectRoot = this.requireSelectedProjectRoot(runtime, pathValue);
    runtime.threadRoots.set(threadId, projectRoot);
    runtime.expandedAccessThreads.delete(threadId);
    this.persistThreadRoots(runtime);
    return { cwd: projectRoot };
  }

  getPendingServerEvents(runtimeId: string, generation: number): LocalAgentEvent[] {
    const runtime = this.findRuntime(runtimeId, generation);
    if (!runtime || (runtime.state !== "ready" && runtime.state !== "needs-auth")) return [];
    return [...runtime.pendingServerRequests.values()].map((message) => ({
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      message,
    }));
  }

  async connect(scopeValue: unknown): Promise<LocalAgentRuntimeHandle> {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.getOrCreateRuntime(scope);
    if (runtime.stopping && runtime.stopPromise) await runtime.stopPromise;
    if ((runtime?.state === "ready" || runtime?.state === "needs-auth") && runtime.process) {
      return this.toHandle(runtime);
    }
    if (runtime?.startPromise) return runtime.startPromise;
    return this.startRuntime(runtime);
  }

  listMcpServers(runtimeId: string, generation: number, scopeValue: unknown): LocalAgentMcpServerSummary[] {
    const runtime = this.requireScopedRuntime(runtimeId, generation, scopeValue);
    return [...runtime.mcpServers.values()].map(toMcpServerSummary);
  }

  async saveMcpServer(
    runtimeId: string,
    generation: number,
    scopeValue: unknown,
    serverValue: unknown,
  ): Promise<LocalAgentMcpServerSummary[]> {
    const runtime = this.requireScopedRuntime(runtimeId, generation, scopeValue);
    const server = parseLocalAgentMcpServerDefinition(serverValue);
    const nextServers = new Map(runtime.mcpServers);
    nextServers.set(server.name, server);
    this.persistMcpServers(runtime, nextServers);
    runtime.mcpServers.clear();
    for (const [name, saved] of nextServers) runtime.mcpServers.set(name, saved);
    await this.writeMcpServerConfig(runtime, nextServers);
    await this.reloadMcpServers(runtime);
    return [...runtime.mcpServers.values()].map(toMcpServerSummary);
  }

  async removeMcpServer(
    runtimeId: string,
    generation: number,
    scopeValue: unknown,
    name: string,
  ): Promise<LocalAgentMcpServerSummary[]> {
    const runtime = this.requireScopedRuntime(runtimeId, generation, scopeValue);
    const nextServers = new Map(runtime.mcpServers);
    if (!nextServers.delete(name)) return [...runtime.mcpServers.values()].map(toMcpServerSummary);
    this.persistMcpServers(runtime, nextServers);
    runtime.mcpServers.clear();
    for (const [serverName, saved] of nextServers) runtime.mcpServers.set(serverName, saved);
    await this.writeMcpServerConfig(runtime, nextServers);
    await this.reloadMcpServers(runtime);
    return [...runtime.mcpServers.values()].map(toMcpServerSummary);
  }

  request(
    runtimeId: string,
    generation: number,
    requestValue: unknown,
    contextValue?: unknown,
    operationIdValue?: unknown,
  ): Promise<LocalAgentJsonValue> {
    try {
      const request = parseLocalAgentRpcRequest(requestValue);
      const context = parseLocalAgentRequestContext(contextValue);
      const runtime = this.requireReadyRuntime(runtimeId, generation);
      if (request.method === "initialize") {
        throw new Error("Local Cerebrum handshake is owned by Desktop.");
      }
      if (runtime.state === "needs-auth" && modelExecutionMethods.has(request.method)) {
        throw new Error("Ardor sign-in is required before sending a local message.");
      }
      const safeRequest = this.applyRuntimePolicy(runtime, request, context);
      if (request.method === "thread/queue/start") {
        return this.startQueuedTurn(runtime, safeRequest, context);
      }
      const operationId = parseOptionalOperationId(operationIdValue) ?? derivedTurnOperationId(safeRequest);
      if (operationId && request.method !== "thread/start" && request.method !== "turn/start") {
        throw new Error("Durable operation identity is only valid for thread or turn start.");
      }
      const send = () => {
        if (request.method === "turn/start" && context.threadId &&
          !runtime.activeTurnAccess.has(context.threadId) &&
          !runtime.pendingTurnAccess.has(context.threadId)) {
          runtime.pendingTurnAccess.set(
            context.threadId,
            runtime.expandedAccessThreads.has(context.threadId),
          );
        }
        return this.sendRequest(runtime, safeRequest, this.requestTimeoutMs);
      };
      let response: Promise<LocalAgentJsonValue>;
      try {
        response = operationId
          ? this.sendDurableOperation(runtime, operationId, safeRequest, context, send)
          : send();
      } catch (cause) {
        if (request.method === "turn/start" && context.threadId && !runtime.activeTurnAccess.has(context.threadId)) {
          runtime.pendingTurnAccess.delete(context.threadId);
        }
        throw cause;
      }
      return response.then((result) => {
        if (request.method === "thread/start" || request.method === "thread/fork") {
          this.rememberThreadRoot(runtime, safeRequest, context, result);
        }
        return result;
      }).catch((cause: unknown) => {
        if (
          request.method === "turn/start" &&
          context.threadId &&
          (cause instanceof LocalAgentRpcError || cause instanceof LocalAgentRequestNotSentError) &&
          !runtime.activeTurnAccess.has(context.threadId)
        ) {
          runtime.pendingTurnAccess.delete(context.threadId);
        }
        throw cause instanceof Error ? cause : new Error("Local Cerebrum request failed.");
      });
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error("Local Cerebrum request is invalid."));
    }
  }

  assertReady(runtimeId: string, generation: number): void {
    this.requireReadyRuntime(runtimeId, generation);
  }

  reply(
    runtimeId: string,
    generation: number,
    requestId: string | number,
    threadId: string,
    result: Record<string, LocalAgentJsonValue>,
  ): Promise<void> {
    const runtime = this.requireReadyRuntime(runtimeId, generation);
    const pending = runtime.pendingServerRequests.get(requestId);
    if (!pending) {
      return Promise.reject(new Error("Local Cerebrum request is not pending."));
    }
    const pendingParams = pending.params;
    const pendingThreadId = isJsonObject(pendingParams) ? getStringProperty(pendingParams, "threadId") : null;
    if (!threadId || pendingThreadId !== threadId) {
      return Promise.reject(new Error("Local Cerebrum request does not belong to this chat."));
    }
    runtime.pendingServerRequests.delete(requestId);
    try {
      runtime.process?.send({ id: requestId, result });
      return Promise.resolve();
    } catch {
      this.failRuntime(runtime, "Local Cerebrum could not accept the reply.");
      return Promise.reject(new Error("Local Cerebrum runtime stopped."));
    }
  }

  onEvent(listener: (event: LocalAgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    for (const runtime of this.runtimes.values()) {
      for (const message of runtime.pendingServerRequests.values()) {
        try {
          listener({ runtimeId: runtime.runtimeId, generation: runtime.generation, message });
        } catch {
          // A renderer reconnect listener cannot disrupt the pending runtime request.
        }
      }
    }
    return () => this.eventListeners.delete(listener);
  }

  markNeedsAuth(runtimeId: string, generation: number): void {
    const runtime = this.findRuntime(runtimeId, generation);
    if (!runtime || runtime.state === "failed" || runtime.state === "stopped" || runtime.state === "stopping") return;
    runtime.state = "needs-auth";
    runtime.lastError = "Ardor sign-in is required for local model requests.";
    this.emitEvent(runtime, { method: "ardor/runtime/needs-auth", params: {} });
  }

  markAuthReady(runtimeId: string, generation: number): void {
    const runtime = this.findRuntime(runtimeId, generation);
    if (!runtime || runtime.state !== "needs-auth") return;
    runtime.state = "ready";
    runtime.lastError = null;
    this.emitEvent(runtime, { method: "ardor/runtime/auth-restored", params: {} });
  }

  async stopAccount(accountId: string): Promise<void> {
    if (accountId.trim().length === 0 || accountId.length > 512) {
      throw new TypeError("Local agent account identity is invalid.");
    }
    await Promise.all(
      [...this.runtimes.values()]
        .filter((runtime) => runtime.scope.accountId === accountId)
        .map((runtime) => this.stopRuntime(runtime)),
    );
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => this.stopRuntime(runtime)));
  }

  private startRuntime(runtime: RuntimeRecord): Promise<LocalAgentRuntimeHandle> {
    runtime.generation += 1;
    runtime.lastError = null;
    runtime.state = "starting";
    runtime.stopping = false;
    mkdirSync(runtime.dataHome, { recursive: true, mode: 0o700 });
    const generation = runtime.generation;
    const startPromise = (async () => {
      const child = await this.createProcess({
        channel: this.channel,
        generation,
        runtimeHome: runtime.dataHome,
        runtimeId: runtime.runtimeId,
        scope: runtime.scope,
      });
      if (runtime.generation !== generation || runtime.state !== "starting") {
        await child.stop();
        throw new Error("Local Cerebrum runtime changed during initialization.");
      }
      runtime.process = child;
      runtime.processMessageListener = (message) => this.handleMessage(runtime, child, generation, message);
      runtime.processExitListener = (code) => this.handleExit(runtime, child, generation, code);
      child.on("message", runtime.processMessageListener);
      child.on("exit", runtime.processExitListener);
      const initializeResult = await this.sendRequest(runtime, {
        id: "ardor-initialize",
        method: "initialize",
        params: initializeParams,
      }, this.handshakeTimeoutMs);
      validateInitializeResponse(initializeResult, this.platform, runtime.dataHome);
      if (runtime.process !== child || runtime.generation !== generation) {
        throw new Error("Local Cerebrum runtime changed during initialization.");
      }
      child.send({ method: "initialized" });
      if (runtime.mcpServers.size > 0) {
        await this.writeMcpServerConfig(runtime, runtime.mcpServers);
        await this.reloadMcpServers(runtime);
      }
      runtime.state = "ready";
      return this.toHandle(runtime);
    })().catch((cause: unknown) => {
      if (runtime.stopping) {
        runtime.state = "stopped";
        runtime.lastError = null;
      } else if (runtime.generation === generation) {
        this.failRuntime(runtime, errorMessage(cause));
      }
      throw cause instanceof Error ? cause : new Error("Local Cerebrum could not start.");
    }).finally(() => {
      if (runtime.startPromise === startPromise) runtime.startPromise = null;
    });
    runtime.startPromise = startPromise;
    return startPromise;
  }

  private sendRequest(
    runtime: RuntimeRecord,
    request: AppServerRequest,
    timeoutMs: number,
  ): Promise<LocalAgentJsonValue> {
    const child = runtime.process;
    if (!child || !isRpcId(request.id) || runtime.pendingRpc.has(request.id)) {
      return Promise.reject(new LocalAgentRequestNotSentError("Local Cerebrum runtime is unavailable."));
    }
    return new Promise<LocalAgentJsonValue>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        if (!runtime.pendingRpc.has(request.id)) return;
        runtime.pendingRpc.delete(request.id);
        reject(new Error("Local Cerebrum request timed out."));
      }, timeoutMs);
      runtime.pendingRpc.set(request.id, {
        reject,
        resolve: resolveResult,
        timer,
      });
      try {
        child.send({ id: request.id, method: request.method, params: request.params });
      } catch {
        clearTimeout(timer);
        runtime.pendingRpc.delete(request.id);
        reject(new LocalAgentRequestNotSentError("Local Cerebrum could not accept the request."));
      }
    });
  }

  private async writeMcpServerConfig(
    runtime: RuntimeRecord,
    servers: ReadonlyMap<string, LocalAgentMcpServerDefinition>,
  ): Promise<void> {
    const mcpServers: Record<string, LocalAgentJsonValue> = {};
    for (const server of servers.values()) {
      const environment: Record<string, LocalAgentJsonValue> = {};
      for (const [name, value] of Object.entries(server.environment)) environment[name] = value;
      mcpServers[server.name] = {
        command: server.command,
        args: [...server.args],
        env: environment,
        enabled: server.enabled,
      };
    }
    await this.sendRequest(runtime, {
      id: `ardor-mcp-config-${randomUUID()}`,
      method: "config/batchWrite",
      params: {
        edits: [{ keyPath: "mcp_servers", value: mcpServers, mergeStrategy: "replace" }],
        filePath: resolve(runtime.dataHome, "config.toml"),
        reloadUserConfig: false,
      },
    }, this.requestTimeoutMs);
  }

  private async reloadMcpServers(runtime: RuntimeRecord): Promise<void> {
    await this.sendRequest(runtime, {
      id: `ardor-mcp-reload-${randomUUID()}`,
      method: "config/mcpServer/reload",
      params: {},
    }, this.requestTimeoutMs);
  }

  private sendDurableOperation(
    runtime: RuntimeRecord,
    operationId: string,
    request: LocalAgentRpcRequest,
    context: LocalAgentRequestContext,
    send: () => Promise<LocalAgentJsonValue>,
  ): Promise<LocalAgentJsonValue> {
    const operationPath = this.operationReceiptPath(runtime, operationId);
    const fingerprint = operationFingerprint(request, context);
    const pending = runtime.pendingOperations.get(operationId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        return Promise.reject(new Error("Durable operation identity was reused for a different request."));
      }
      return pending.promise;
    }

    const existing = this.readOperationReceipt(operationPath, operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error("Durable operation identity was reused for a different request."));
      }
      if (existing.status === "accepted" && existing.response !== undefined) {
        return Promise.resolve(existing.response);
      }
      if (existing.status === "outcome-unknown") {
        return Promise.reject(new Error("The previous operation outcome is unknown. It was not sent again."));
      }
    }

    // Persist uncertainty before crossing the process boundary. If Desktop
    // exits between this write and the response, retry can never duplicate it.
    this.writePrivateJson(operationPath, {
      schemaVersion: 1,
      operationId,
      fingerprint,
      status: "outcome-unknown",
    } satisfies DurableOperationReceipt);
    const promise = send().then((response) => {
      this.writePrivateJson(operationPath, {
        schemaVersion: 1,
        operationId,
        fingerprint,
        status: "accepted",
        response,
      } satisfies DurableOperationReceipt);
      return response;
    }).finally(() => {
      runtime.pendingOperations.delete(operationId);
    });
    runtime.pendingOperations.set(operationId, { fingerprint, promise });
    return promise;
  }

  private operationReceiptPath(runtime: RuntimeRecord, operationId: string): string {
    const operationHash = createHash("sha256").update(operationId).digest("hex");
    return resolve(runtime.dataHome, "operations", `${operationHash}.json`);
  }

  private readOperationReceipt(path: string, operationId: string): DurableOperationReceipt | null {
    if (!existsSync(path)) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !isJsonObject(value) || value.schemaVersion !== 1 || value.operationId !== operationId ||
      typeof value.fingerprint !== "string" ||
      (value.status !== "accepted" && value.status !== "not-started" && value.status !== "outcome-unknown")
    ) {
      throw new Error("Durable local operation receipt is invalid; refusing to replay it.");
    }
    if (value.status === "accepted") {
      if (!isJsonValue(value.response)) {
        throw new Error("Durable local operation receipt is invalid; refusing to replay it.");
      }
      return {
        schemaVersion: 1,
        operationId,
        fingerprint: value.fingerprint,
        status: "accepted",
        response: value.response,
      };
    }
    if (value.status === "not-started") {
      return { schemaVersion: 1, operationId, fingerprint: value.fingerprint, status: "not-started" };
    }
    return { schemaVersion: 1, operationId, fingerprint: value.fingerprint, status: "outcome-unknown" };
  }

  private handleMessage(
    runtime: RuntimeRecord,
    child: LocalAgentProcess,
    generation: number,
    value: unknown,
  ): void {
    if (runtime.process !== child || runtime.generation !== generation) return;
    let message: Record<string, LocalAgentJsonValue>;
    try {
      message = parseLocalAgentJsonObject(value);
    } catch {
      this.failRuntime(runtime, "Local Cerebrum returned an invalid message.");
      return;
    }
    if (typeof message.method === "string") {
      this.trackActiveTurnAccess(runtime, message);
      if (isRpcId(message.id)) {
        if (runtime.pendingServerRequests.has(message.id) || runtime.pendingRpc.has(message.id)) return;
        runtime.pendingServerRequests.set(message.id, message);
      }
      this.emitEvent(runtime, message);
      return;
    }
    if (!isRpcId(message.id)) return;
    const pending = runtime.pendingRpc.get(message.id);
    if (!pending) return;
    runtime.pendingRpc.delete(message.id);
    clearTimeout(pending.timer);
    if (isJsonObject(message.error)) {
      const errorMessage = typeof message.error.message === "string" ? message.error.message : "Local Cerebrum RPC failed.";
      // App-server methods may report an error after asynchronous work or
      // persistence has begun. Preserve the durable unknown receipt so a
      // response error can never turn into a duplicate retry.
      pending.reject(new LocalAgentRpcError(errorMessage));
      return;
    }
    if (!isJsonValue(message.result)) {
      pending.reject(new Error("Local Cerebrum returned an invalid response."));
      return;
    }
    pending.resolve(message.result);
  }

  private handleExit(
    runtime: RuntimeRecord,
    child: LocalAgentProcess,
    generation: number,
    code: number,
  ): void {
    if (runtime.process !== child || runtime.generation !== generation) return;
    if (runtime.stopping) {
      runtime.process = null;
      runtime.state = "stopped";
      return;
    }
    this.failRuntime(runtime, `Local Cerebrum runtime stopped (exit ${code}).`);
    this.emitEvent(runtime, { method: "ardor/runtime/disconnected", params: {} });
  }

  private failRuntime(runtime: RuntimeRecord, message: string): void {
    const child = runtime.process;
    if (child) this.detachProcess(runtime, child);
    runtime.process = null;
    runtime.state = "failed";
    runtime.lastError = message;
    runtime.startPromise = null;
    runtime.pendingServerRequests.clear();
    runtime.expandedAccessThreads.clear();
    runtime.pendingTurnAccess.clear();
    runtime.activeTurnAccess.clear();
    this.rejectPending(runtime, new Error("Local Cerebrum runtime stopped."));
    if (child) void child.stop().catch(() => undefined);
  }

  private rejectPending(runtime: RuntimeRecord, error: Error): void {
    for (const pending of runtime.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    runtime.pendingRpc.clear();
  }

  private detachProcess(runtime: RuntimeRecord, child: LocalAgentProcess): void {
    if (runtime.processMessageListener) child.removeListener("message", runtime.processMessageListener);
    if (runtime.processExitListener) child.removeListener("exit", runtime.processExitListener);
    runtime.processMessageListener = null;
    runtime.processExitListener = null;
  }

  private applyRuntimePolicy(
    runtime: RuntimeRecord,
    request: LocalAgentRpcRequest,
    context: LocalAgentRequestContext,
  ): LocalAgentRpcRequest {
    const params: Record<string, LocalAgentJsonValue> = { ...request.params };
    if (request.method === "thread/start") {
      const projectRoot = this.requireSelectedProjectRoot(runtime, context.cwd);
      applyThreadSandbox(params, projectRoot);
      return { ...request, params };
    }

    if (request.method === "thread/list") {
      if (context.cwd !== undefined) params.cwd = this.requireSelectedProjectRoot(runtime, context.cwd);
      return { ...request, params };
    }

    let projectRoot: string | undefined;
    if (request.method === "thread/fork" || threadScopedMethods.has(request.method)) {
      const threadId = context.threadId;
      if (!threadId || getStringProperty(params, "threadId") !== threadId || !runtime.threadRoots.has(threadId)) {
        throw new Error("Thread is not owned by this local runtime.");
      }
      projectRoot = runtime.threadRoots.get(threadId);
      if (!projectRoot || !existsSync(projectRoot) || !this.isDirectory(projectRoot)) {
        throw new Error("Project folder is missing. Choose its location to continue.");
      }
      if (context.cwd === undefined || this.resolveProjectRoot(context.cwd) !== projectRoot) {
        throw new Error("Local chat project folder does not match its saved location.");
      }
      if (request.method === "thread/resume" || request.method === "thread/fork") {
        applyThreadSandbox(params, projectRoot);
      }
      if (request.method === "thread/settings/update") {
        params.cwd = projectRoot;
        params.approvalPolicy = "on-request";
        params.approvalsReviewer = "user";
        params.sandboxPolicy = this.getThreadSandboxPolicy(runtime, context.threadId, projectRoot);
        delete params.permissions;
      }
      if (request.method === "turn/start") {
        params.cwd = projectRoot;
        params.runtimeWorkspaceRoots = [projectRoot];
        params.approvalPolicy = "on-request";
        params.approvalsReviewer = "user";
        params.sandboxPolicy = this.getThreadSandboxPolicy(runtime, context.threadId, projectRoot);
        delete params.permissions;
        delete params.environments;
        delete params.cyberAccessProgram;
      }
      if (request.method === "turn/steer") {
        delete params.cwd;
        delete params.runtimeWorkspaceRoots;
        delete params.approvalPolicy;
        delete params.approvalsReviewer;
        delete params.sandboxPolicy;
        delete params.permissions;
        delete params.environments;
        delete params.cyberAccessProgram;
      }
    }

    if (request.method.startsWith("fs/") || request.method.startsWith("fuzzyFileSearch")) {
      if (!projectRoot) {
        projectRoot = this.requireThreadProjectRoot(runtime, context);
      }
      const filePath = getStringProperty(params, "path");
      if (request.method.startsWith("fs/")) {
        if (!filePath || !this.canAccessPath(runtime, context.threadId, projectRoot, filePath)) {
          throw new Error("File operation is outside this local chat's project folder.");
        }
        params.sandboxContext = {
          cwd: projectRoot,
          sandboxPolicy: this.getThreadSandboxPolicy(runtime, context.threadId, projectRoot),
        };
      } else if (filePath !== null && !this.canAccessPath(runtime, context.threadId, projectRoot, filePath)) {
        throw new Error("File operation is outside this local chat's project folder.");
      }
      if (request.method === "fuzzyFileSearch" || request.method === "fuzzyFileSearch/sessionStart") {
        params.cwd = projectRoot;
      }
    }

    if (request.method === "command/exec") {
      projectRoot = this.requireThreadProjectRoot(runtime, context);
      params.cwd = projectRoot;
      params.permissionProfile = this.isExpandedAccessInEffect(runtime, context.threadId)
        ? ":danger-full-access"
        : "ardor-local-workspace";
      delete params.sandboxPolicy;
    }

    return { ...request, params };
  }

  private resolveProjectRoot(value: unknown): string {
    const path = resolveLocalProjectPath(value, this.platform);
    if (!existsSync(path) || !this.isDirectory(path)) {
      throw new Error("Choose an existing local project folder.");
    }
    return realpathSync(path);
  }

  private requireSelectedProjectRoot(runtime: RuntimeRecord, value: unknown): string {
    const projectRoot = this.resolveProjectRoot(value);
    if (!runtime.selectedProjectRoots.has(projectRoot)) {
      throw new Error("Select the project folder from Desktop before starting a local chat.");
    }
    return projectRoot;
  }

  private requireThreadProjectRoot(runtime: RuntimeRecord, context: LocalAgentRequestContext): string {
    if (!context.threadId || !context.cwd) {
      throw new Error("Local file and command operations require a chat project context.");
    }
    const projectRoot = runtime.threadRoots.get(context.threadId);
    if (!projectRoot || !existsSync(projectRoot) || !this.isDirectory(projectRoot)) {
      throw new Error("Project folder is missing. Choose its location to continue.");
    }
    if (this.resolveProjectRoot(context.cwd) !== projectRoot) {
      throw new Error("Local chat project folder does not match its saved location.");
    }
    return projectRoot;
  }

  private isPathWithinRoot(projectRoot: string, value: string): boolean {
    const path = resolveLocalProjectPath(value, this.platform);
    const candidate = this.resolvePossiblyMissingPath(path);
    return isPathWithin(projectRoot, candidate);
  }

  private canAccessPath(
    runtime: RuntimeRecord,
    threadId: string | undefined,
    projectRoot: string,
    value: string,
  ): boolean {
    if (this.isExpandedAccessInEffect(runtime, threadId)) {
      resolveLocalProjectPath(value, this.platform);
      return true;
    }
    return this.isPathWithinRoot(projectRoot, value);
  }

  private getThreadSandboxPolicy(
    runtime: RuntimeRecord,
    threadId: string | undefined,
    projectRoot: string,
    expandedAccess = this.isExpandedAccessInEffect(runtime, threadId),
  ): Record<string, LocalAgentJsonValue> {
    return expandedAccess
      ? { type: "dangerFullAccess" }
      : buildWorkspaceSandboxPolicy(projectRoot);
  }

  private isExpandedAccessInEffect(runtime: RuntimeRecord, threadId: string | undefined): boolean {
    if (!threadId) return false;
    return runtime.activeTurnAccess.get(threadId) ??
      runtime.pendingTurnAccess.get(threadId) ??
      runtime.expandedAccessThreads.has(threadId);
  }

  private startQueuedTurn(
    runtime: RuntimeRecord,
    request: LocalAgentRpcRequest,
    context: LocalAgentRequestContext,
  ): Promise<LocalAgentJsonValue> {
    const threadId = context.threadId;
    if (!threadId) return Promise.reject(new Error("Local queued turns require a chat project context."));
    const projectRoot = this.requireThreadProjectRoot(runtime, context);
    const settingsRequest: LocalAgentRpcRequest = {
      id: `ardor-queue-access-${randomUUID()}`,
      method: "thread/settings/update",
      params: {
        threadId,
        cwd: projectRoot,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: this.getThreadSandboxPolicy(
          runtime,
          threadId,
          projectRoot,
          runtime.expandedAccessThreads.has(threadId),
        ),
      },
    };
    return this.sendRequest(runtime, settingsRequest, this.requestTimeoutMs).then(() =>
      this.sendRequest(runtime, request, this.requestTimeoutMs),
    );
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  private resolvePossiblyMissingPath(path: string): string {
    let existingAncestor = path;
    const trailingParts: string[] = [];
    for (;;) {
      let exists = false;
      try {
        lstatSync(existingAncestor);
        exists = true;
      } catch (cause) {
        if (!isNodeErrorCode(cause, "ENOENT")) throw cause;
      }
      if (exists) {
        // lstat recognizes dangling links, while realpath resolves valid links
        // before the workspace containment check below.
        try {
          return resolve(realpathSync(existingAncestor), ...trailingParts);
        } catch (cause) {
          if (isNodeErrorCode(cause, "ENOENT")) {
            throw new Error("Local project path uses a symbolic link with a missing target.");
          }
          throw cause;
        }
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw new Error("Local project path is invalid.");
      trailingParts.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  private rememberThreadRoot(
    runtime: RuntimeRecord,
    request: LocalAgentRpcRequest,
    context: LocalAgentRequestContext,
    result: LocalAgentJsonValue,
  ): void {
    const threadId = readThreadId(result);
    if (!threadId) return;
    const sourceId = request.method === "thread/fork" ? getStringProperty(request.params, "threadId") : null;
    const root = request.method === "thread/start"
      ? context.cwd ? runtime.selectedProjectRoots.has(this.resolveProjectRoot(context.cwd))
        ? this.resolveProjectRoot(context.cwd) : undefined : undefined
      : sourceId ? runtime.threadRoots.get(sourceId) : undefined;
    if (!root) return;
    runtime.threadRoots.set(threadId, root);
    this.persistThreadRoots(runtime);
  }

  private persistThreadRoots(runtime: RuntimeRecord): void {
    this.writePrivateJson(resolve(runtime.dataHome, "thread-project-roots.json"), {
      schemaVersion: 1,
      threads: Object.fromEntries(runtime.threadRoots.entries()),
    });
  }

  private persistProjectRoots(runtime: RuntimeRecord): void {
    this.writePrivateJson(resolve(runtime.dataHome, "project-roots.json"), {
      schemaVersion: 1,
      roots: [...runtime.selectedProjectRoots],
    });
  }

  private writePrivateJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 });
    try {
      renameSync(temporaryPath, path);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original persistence failure.
      }
      throw error;
    }
  }

  private createRuntimeRecord(scope: LocalAgentRuntimeScope, key: string): RuntimeRecord {
    const accountHash = hashScopePart(scope.accountId);
    const workspaceHash = hashScopePart(scope.workspaceId);
    const dataHome = resolve(this.userDataPath, "local-cerebrum", this.channel, accountHash, workspaceHash);
    return {
      dataHome,
      key,
      pendingRpc: new Map(),
      pendingOperations: new Map(),
      pendingServerRequests: new Map(),
      mcpServers: this.readMcpServers(dataHome),
      scope,
      selectedProjectRoots: this.readProjectRoots(dataHome),
      threadRoots: this.readThreadRoots(dataHome),
      expandedAccessThreads: new Set(),
      pendingTurnAccess: new Map(),
      activeTurnAccess: new Map(),
      generation: 0,
      lastError: null,
      process: null,
      processExitListener: null,
      processMessageListener: null,
      runtimeId: this.createRuntimeId?.() ?? `local-${hashScopePart(key)}`,
      startPromise: null,
      stopPromise: null,
      state: "stopped",
      stopping: false,
    };
  }

  private readThreadRoots(dataHome: string): Map<string, string> {
    const mapPath = resolve(dataHome, "thread-project-roots.json");
    if (!existsSync(mapPath)) return new Map();
    try {
      const value: unknown = JSON.parse(readFileSync(mapPath, "utf8"));
      if (!isJsonObject(value) || value.schemaVersion !== 1 || !isJsonObject(value.threads)) return new Map();
      const entries: Array<[string, string]> = [];
      for (const [threadId, path] of Object.entries(value.threads)) {
        if (typeof path === "string" && isAbsolute(path)) entries.push([threadId, path]);
      }
      return new Map(entries);
    } catch {
      return new Map();
    }
  }

  private readProjectRoots(dataHome: string): Set<string> {
    const rootsPath = resolve(dataHome, "project-roots.json");
    if (!existsSync(rootsPath)) return new Set();
    try {
      const value: unknown = JSON.parse(readFileSync(rootsPath, "utf8"));
      if (!isJsonObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.roots)) return new Set();
      const roots: string[] = [];
      for (const path of value.roots) {
        if (typeof path !== "string" || !isAbsolute(path) || !existsSync(path) || !this.isDirectory(path)) continue;
        roots.push(realpathSync(path));
      }
      return new Set(roots);
    } catch {
      return new Set();
    }
  }

  private readMcpServers(dataHome: string): Map<string, LocalAgentMcpServerDefinition> {
    const path = resolve(dataHome, "mcp-servers.json");
    if (!existsSync(path)) return new Map();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.servers)) {
      throw new Error("Local MCP configuration is invalid; refusing to start without it.");
    }
    const servers = new Map<string, LocalAgentMcpServerDefinition>();
    for (const candidate of value.servers) {
      const server = parseLocalAgentMcpServerDefinition(candidate);
      if (servers.has(server.name)) {
        throw new Error("Local MCP configuration contains duplicate server names.");
      }
      servers.set(server.name, server);
    }
    return servers;
  }

  private persistMcpServers(
    runtime: RuntimeRecord,
    servers: ReadonlyMap<string, LocalAgentMcpServerDefinition>,
  ): void {
    this.writePrivateJson(resolve(runtime.dataHome, "mcp-servers.json"), {
      schemaVersion: 1,
      servers: [...servers.values()],
    });
  }

  private getOrCreateRuntime(scope: LocalAgentRuntimeScope): RuntimeRecord {
    const key = this.getScopeKey(scope);
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    const runtime = this.createRuntimeRecord(scope, key);
    this.runtimes.set(key, runtime);
    return runtime;
  }

  private getScopeKey(scope: LocalAgentRuntimeScope): string {
    return `${this.channel}:${hashScopePart(scope.accountId)}:${hashScopePart(scope.workspaceId)}`;
  }

  private stopRuntime(runtime: RuntimeRecord): Promise<void> {
    if (runtime.stopPromise) return runtime.stopPromise;
    runtime.stopping = true;
    runtime.state = "stopping";
    runtime.lastError = null;
    runtime.pendingServerRequests.clear();
    runtime.expandedAccessThreads.clear();
    runtime.pendingTurnAccess.clear();
    runtime.activeTurnAccess.clear();
    this.rejectPending(runtime, new Error("Local Cerebrum runtime stopped."));
    const child = runtime.process;
    const startPromise = runtime.startPromise;
    if (child) {
      this.detachProcess(runtime, child);
      runtime.process = null;
    }
    const stopPromise = (async () => {
      if (child) {
        try {
          await child.stop();
        } catch {
          runtime.lastError = "Local Cerebrum could not stop cleanly.";
        }
      } else if (startPromise) {
        await startPromise.catch(() => undefined);
      }
      runtime.state = "stopped";
      runtime.stopping = false;
      runtime.startPromise = null;
    })();
    runtime.stopPromise = stopPromise;
    void stopPromise.finally(() => {
      if (runtime.stopPromise === stopPromise) runtime.stopPromise = null;
    });
    return stopPromise;
  }

  private requireReadyRuntime(runtimeId: string, generation: number): RuntimeRecord {
    const runtime = this.findRuntime(runtimeId, generation);
    if (!runtime || (runtime.state !== "ready" && runtime.state !== "needs-auth") || !runtime.process) {
      throw new Error("Local Cerebrum runtime is unavailable.");
    }
    return runtime;
  }

  private requireScopedRuntime(runtimeId: string, generation: number, scopeValue: unknown): RuntimeRecord {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const runtime = this.requireReadyRuntime(runtimeId, generation);
    if (runtime.key !== this.getScopeKey(scope)) {
      throw new Error("Local MCP settings do not belong to this runtime scope.");
    }
    return runtime;
  }

  private findRuntime(runtimeId: string, generation: number): RuntimeRecord | undefined {
    return [...this.runtimes.values()].find((candidate) =>
      candidate.runtimeId === runtimeId && candidate.generation === generation,
    );
  }

  private toHandle(runtime: RuntimeRecord): LocalAgentRuntimeHandle {
    return { runtimeId: runtime.runtimeId, generation: runtime.generation, state: runtime.state };
  }

  private toStatus(runtime: RuntimeRecord): LocalAgentRuntimeStatus {
    return { ...this.toHandle(runtime), lastError: runtime.lastError };
  }

  private emitEvent(runtime: RuntimeRecord, message: Record<string, LocalAgentJsonValue>): void {
    const event = { runtimeId: runtime.runtimeId, generation: runtime.generation, message };
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
        // Renderer listeners are isolated from runtime process lifecycle.
      }
    }
  }

  private trackActiveTurnAccess(runtime: RuntimeRecord, message: Record<string, LocalAgentJsonValue>): void {
    if (message.method !== "turn/started" && message.method !== "turn/completed") return;
    if (!isJsonObject(message.params)) return;
    const threadId = getStringProperty(message.params, "threadId");
    if (!threadId) return;
    if (message.method === "turn/completed") {
      runtime.activeTurnAccess.delete(threadId);
      runtime.pendingTurnAccess.delete(threadId);
      return;
    }
    if (!runtime.activeTurnAccess.has(threadId)) {
      runtime.activeTurnAccess.set(
        threadId,
        runtime.pendingTurnAccess.get(threadId) ?? runtime.expandedAccessThreads.has(threadId),
      );
    }
    runtime.pendingTurnAccess.delete(threadId);
  }
}

function parseChannel(value: string): string {
  if (!/^[a-z0-9-]{1,32}$/.test(value)) {
    throw new TypeError("local agent build channel is invalid");
  }
  return value;
}

function validateInitializeResponse(
  value: LocalAgentJsonValue,
  platform: NodeJS.Platform,
  runtimeHome: string,
): void {
  if (!isJsonObject(value)) {
    throw new Error("Local Cerebrum returned an invalid initialize response.");
  }
  const userAgent = getStringProperty(value, "userAgent");
  const codexHome = getStringProperty(value, "codexHome");
  const platformFamily = getStringProperty(value, "platformFamily");
  const platformOs = getStringProperty(value, "platformOs");
  const expectedFamily = platform === "win32" ? "windows" : "unix";
  const expectedOs = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform;

  if (!userAgent || !/^[\w.-]+(?:[ \t]+[\w.-]+)*\/\S+/.test(userAgent) || !codexHome || !isAbsolute(codexHome) ||
      platformFamily !== expectedFamily || platformOs !== expectedOs ||
      normalizeRuntimeHome(codexHome, platform) !== normalizeRuntimeHome(runtimeHome, platform)) {
    throw new Error("Local Cerebrum initialize response is incompatible with this Desktop runtime.");
  }
}

function normalizeRuntimeHome(value: string, platform: NodeJS.Platform): string {
  const normalized = resolve(value);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function hashScopePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function parseOptionalOperationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512 || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError("Local operation identity is invalid.");
  }
  return value;
}

function derivedTurnOperationId(request: LocalAgentRpcRequest): string | undefined {
  if (request.method !== "turn/start") return undefined;
  const threadId = getStringProperty(request.params, "threadId");
  const messageId = getStringProperty(request.params, "clientUserMessageId");
  if (!threadId || !messageId) return undefined;
  return parseOptionalOperationId(`turn:v1:${threadId}:${messageId}`);
}

function operationFingerprint(request: LocalAgentRpcRequest, context: LocalAgentRequestContext): string {
  const serializedContext: Record<string, LocalAgentJsonValue> = {};
  if (context.cwd !== undefined) serializedContext.cwd = context.cwd;
  if (context.threadId !== undefined) serializedContext.threadId = context.threadId;
  const value = {
    method: request.method,
    params: canonicalizeJson(request.params),
    context: canonicalizeJson(serializedContext),
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalizeJson(value: LocalAgentJsonValue): LocalAgentJsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, LocalAgentJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalizeJson(value[key]);
  }
  return result;
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && "code" in value && value.code === code;
}

function isJsonObject(value: unknown): value is Record<string, LocalAgentJsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is LocalAgentJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

function isRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function getStringProperty(value: Record<string, LocalAgentJsonValue>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function readThreadId(value: LocalAgentJsonValue): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const thread = value.thread;
  if (typeof thread !== "object" || thread === null || Array.isArray(thread)) return null;
  return typeof thread.id === "string" ? thread.id : null;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Local Cerebrum could not start.";
}

export function parseLocalAgentMcpServerDefinition(value: unknown): LocalAgentMcpServerDefinition {
  if (!isJsonObject(value)) throw new TypeError("Local MCP server configuration is invalid.");
  const { name, command, enabled, args: rawArgs, environment: rawEnvironment } = value;
  if (
    typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
    typeof command !== "string" || command.trim().length === 0 || command.length > 1024 ||
    typeof enabled !== "boolean" || !Array.isArray(rawArgs) || rawArgs.length > 128 ||
    !isJsonObject(rawEnvironment)
  ) {
    throw new TypeError("Local MCP server configuration is invalid.");
  }
  const args: string[] = [];
  for (const rawArgument of rawArgs) {
    if (typeof rawArgument !== "string" || rawArgument.length > 4096) {
      throw new TypeError("Local MCP server arguments are invalid.");
    }
    args.push(rawArgument);
  }
  const environment: Record<string, string> = {};
  let environmentBytes = 0;
  for (const [key, rawValue] of Object.entries(rawEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof rawValue !== "string" || rawValue.length > 8192) {
      throw new TypeError("Local MCP environment variables are invalid.");
    }
    environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(rawValue);
    if (environmentBytes > 32_768) throw new RangeError("Local MCP environment is too large.");
    environment[key] = rawValue;
  }
  return { name, command: command.trim(), args, environment, enabled };
}

function toMcpServerSummary(server: LocalAgentMcpServerDefinition): LocalAgentMcpServerSummary {
  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    environmentKeys: Object.keys(server.environment).sort(),
    enabled: server.enabled,
  };
}

function applyThreadSandbox(params: Record<string, LocalAgentJsonValue>, projectRoot: string): void {
  params.cwd = projectRoot;
  params.runtimeWorkspaceRoots = [projectRoot];
  params.sandbox = "workspace-write";
  params.approvalPolicy = "on-request";
  params.approvalsReviewer = "user";
  params.modelProvider = "ardor";
  delete params.sandboxPolicy;
  delete params.permissions;
  delete params.config;
  delete params.dynamicTools;
  delete params.environments;
  delete params.selectedCapabilityRoots;
  delete params.history;
  delete params.path;
}

function buildWorkspaceSandboxPolicy(projectRoot: string): Record<string, LocalAgentJsonValue> {
  return {
    type: "workspaceWrite",
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}
