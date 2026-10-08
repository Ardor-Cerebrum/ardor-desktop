import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  LocalAgentConnection,
  LocalAgentMcpServerSummary,
  LocalAgentOperationOutcome,
  LocalAgentStatus,
  LocalAgentThreadAccessRequest,
  LocalAgentThreadAccessState,
  LocalAgentThreadProjectFolder,
  LocalAgentThreadProjectFolderUpdateResult,
} from "../bridge-contract.js";
import { resolveNativeApiOrigin } from "../native-proxy.js";
import {
  LocalAgentRuntimeManager,
  type LocalAgentEvent,
  type LocalAgentMcpServerSummary as RuntimeMcpServerSummary,
  type LocalAgentRuntimeHandle,
  parseLocalAgentMcpServerDefinition,
} from "./runtime-manager.js";
import { LocalResponsesRelay } from "./responses-relay.js";
import {
  buildLocalAgentEnvironment,
  buildLocalAgentProviderConfig,
  createLocalAgentStdioProcess,
} from "./stdio-process.js";
import { isLocalAgentAccessToken, LocalAgentTokenBroker, type LocalAgentTokenRequest } from "./token-broker.js";
import {
  parseLocalAgentJsonObject,
  parseLocalAgentRequestContext,
  parseLocalAgentRpcRequest,
  parseLocalAgentRuntimeScope,
  type LocalAgentJsonValue,
} from "./protocol.js";
import { resolveVerifiedLocalAgentBundle, type VerifiedLocalAgentBundle } from "./bundle.js";
import { LocalModelCatalogClient } from "./model-catalog.js";

export interface LocalAgentDesktopHostOptions {
  readonly apiOrigin: string;
  readonly arch: string;
  readonly channel: string;
  readonly platform: NodeJS.Platform;
  readonly userDataPath: string;
  readonly bundleRoot: string;
  readonly appBundleRoot?: string;
  readonly expectedSourceCommit: string | undefined;
  readonly expectedManifestSha256: string | undefined;
  readonly confirmExpandedAccess?: (
    request: LocalAgentThreadAccessRequest & { readonly cwd: string },
  ) => Promise<boolean>;
  readonly fetch?: typeof fetch;
}

interface ParsedBridgeConnection {
  readonly runtimeId: string;
  readonly generation: number;
}

interface ActiveRelay {
  readonly accountId: string;
  readonly generation: number;
  readonly relay: LocalResponsesRelay;
  readonly runtimeId: string;
}

const LOCAL_REQUEST_ID_MAX_LENGTH = 256;
const LOCAL_AGENT_IPC_MAX_BYTES = 16 * 1024 * 1024;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const DESKTOP_SCOPE_VERIFICATION_PATH = "/haron-api/api/cerebrum/desktop/scope";
const SCOPE_AUTHORIZATION_TTL_MS = 60_000;
const SCOPE_VERIFICATION_TIMEOUT_MS = 10_000;
const SCOPE_VERIFICATION_ERROR = "Local account or workspace scope could not be verified.";

/** Main-process owner for local Cerebrum processes, their relays, and token requests. */
export class LocalAgentDesktopHost {
  readonly manager: LocalAgentRuntimeManager;
  readonly tokenBroker: LocalAgentTokenBroker;
  readonly bundle: VerifiedLocalAgentBundle | null;
  readonly bundleError: string | null;
  private readonly apiOrigin: string;
  private readonly fetcher: typeof fetch;
  private readonly modelCatalog: LocalModelCatalogClient;
  private readonly confirmExpandedAccess: NonNullable<LocalAgentDesktopHostOptions["confirmExpandedAccess"]>;
  private readonly activeRelays = new Map<string, ActiveRelay>();
  private readonly authorizedScopes = new Map<string, { readonly scope: ReturnType<typeof parseLocalAgentRuntimeScope>; readonly expiresAt: number }>();
  private readonly scopeAuthorizationPromises = new Map<string, Promise<void>>();
  private readonly verifiedScopeTokens = new Map<string, {
    readonly scope: ReturnType<typeof parseLocalAgentRuntimeScope>;
    readonly expiresAt: number;
  }>();

  constructor(options: LocalAgentDesktopHostOptions) {
    this.apiOrigin = resolveNativeApiOrigin(options.apiOrigin, options.channel);
    this.fetcher = options.fetch ?? fetch;
    this.modelCatalog = new LocalModelCatalogClient({ apiOrigin: this.apiOrigin, fetch: this.fetcher });
    this.confirmExpandedAccess = options.confirmExpandedAccess ?? (async () => false);
    this.tokenBroker = new LocalAgentTokenBroker();
    try {
      this.bundle = resolveVerifiedLocalAgentBundle(
        options.bundleRoot,
        options.platform,
        options.arch,
        options.expectedSourceCommit,
        options.expectedManifestSha256,
        options.appBundleRoot ? { appBundleRoot: options.appBundleRoot } : {},
      );
      this.bundleError = null;
    } catch (cause) {
      this.bundle = null;
      this.bundleError = cause instanceof Error ? cause.message : "Bundled Cerebrum runtime is unavailable.";
    }
    this.manager = new LocalAgentRuntimeManager({
      channel: options.channel,
      userDataPath: options.userDataPath,
      platform: options.platform,
      createProcess: async (processOptions) => {
        const bundle = this.bundle;
        if (!bundle) throw new Error(this.bundleError ?? "Bundled Cerebrum runtime is unavailable.");
        const relay = new LocalResponsesRelay({
          apiOrigin: this.apiOrigin,
          runtimeId: processOptions.runtimeId,
          generation: processOptions.generation,
          scope: processOptions.scope,
          getAccessToken: (forceRefresh) => this.tokenBroker.requestToken({
            ...processOptions.scope,
            runtimeId: processOptions.runtimeId,
            generation: processOptions.generation,
          }, forceRefresh),
          onAuthStateChange: (state) => {
            if (state === "needs-auth") {
              this.manager.markNeedsAuth(processOptions.runtimeId, processOptions.generation);
            } else {
              this.manager.markAuthReady(processOptions.runtimeId, processOptions.generation);
            }
          },
        });
        const runtimeKey = getRuntimeKey(processOptions.runtimeId, processOptions.generation);
        try {
          const relayPort = await relay.start();
          writeRuntimeProviderConfig(processOptions.runtimeHome, relayPort);
          const child = createLocalAgentStdioProcess({
            command: bundle.executablePath,
            args: bundle.args,
            cwd: processOptions.runtimeHome,
            env: buildLocalAgentEnvironment(process.env, processOptions.runtimeHome, relay.token),
            platform: options.platform,
          });
          this.activeRelays.set(runtimeKey, {
            accountId: processOptions.scope.accountId,
            generation: processOptions.generation,
            relay,
            runtimeId: processOptions.runtimeId,
          });
          child.on("exit", () => {
            this.tokenBroker.cancelRuntime(processOptions.runtimeId, processOptions.generation);
            void this.stopRelay(runtimeKey);
          });
          return child;
        } catch (cause) {
          await relay.stop();
          throw cause;
        }
      },
    });
  }

  async getStatus(scopeValue: unknown): Promise<LocalAgentStatus> {
    const scope = await this.ensureAuthorizedScope(scopeValue);
    const status = await this.manager.getStatus(scope);
    return {
      runtimeId: status.runtimeId,
      generation: status.generation,
      state: status.state,
      available: this.bundle !== null,
      error: this.bundle ? status.lastError : this.bundleError,
    };
  }

  async authorizeProjectFolder(scopeValue: unknown, pathValue: unknown): Promise<string> {
    const scope = await this.ensureAuthorizedScope(scopeValue);
    this.requireBundle();
    return this.manager.authorizeProjectFolder(scope, pathValue);
  }

  async connect(scopeValue: unknown): Promise<LocalAgentConnection> {
    const scope = await this.ensureAuthorizedScope(scopeValue);
    this.requireBundle();
    const handle = await this.manager.connect(scope);
    return toConnection(handle);
  }

  async getPendingEvents(connectionValue: unknown): Promise<LocalAgentEvent[]> {
    if (!isRecord(connectionValue)) throw new TypeError("local agent runtime identity is invalid");
    const connection = parseBridgeConnection(connectionValue);
    await this.ensureAuthorizedRuntime(connection);
    return this.manager.getPendingServerEvents(connection.runtimeId, connection.generation);
  }

  getPendingTokenRequests(accountIdValue: unknown): LocalAgentTokenRequest[] {
    if (typeof accountIdValue !== "string" || accountIdValue.trim().length === 0 || accountIdValue.length > 512) {
      throw new TypeError("local agent account identity is invalid");
    }
    return this.tokenBroker.getPendingRequests(accountIdValue);
  }

  async getThreadAccess(value: unknown): Promise<LocalAgentThreadAccessState> {
    const request = parseThreadAccessRequest(value);
    await this.ensureAuthorizedScope(request);
    return this.manager.getThreadAccess(
      request.runtimeId,
      request.generation,
      request,
      request.threadId,
    );
  }

  async setThreadAccess(value: unknown): Promise<LocalAgentThreadAccessState> {
    const request = parseThreadAccessRequest(value);
    await this.ensureAuthorizedScope(request);
    if (!isRecord(value) || typeof value.expanded !== "boolean") {
      throw new TypeError("local chat access setting is invalid");
    }
    if (value.expanded) {
      const projectFolder = this.manager.getThreadProjectFolder(
        request.runtimeId,
        request.generation,
        request,
        request.threadId,
      );
      if (!projectFolder?.exists) {
        return this.manager.setThreadAccess(
          request.runtimeId,
          request.generation,
          request,
          request.threadId,
          true,
        );
      }
      const confirmed = await this.confirmExpandedAccess({ ...request, cwd: projectFolder.cwd });
      if (!confirmed) {
        return this.manager.getThreadAccess(
          request.runtimeId,
          request.generation,
          request,
          request.threadId,
        );
      }
    }
    return this.manager.setThreadAccess(
      request.runtimeId,
      request.generation,
      request,
      request.threadId,
      value.expanded,
    );
  }

  async getThreadProjectFolder(value: unknown): Promise<LocalAgentThreadProjectFolder | null> {
    const request = parseThreadAccessRequest(value);
    await this.ensureAuthorizedScope(request);
    return this.manager.getThreadProjectFolder(
      request.runtimeId,
      request.generation,
      request,
      request.threadId,
    );
  }

  async setThreadProjectFolder(value: unknown): Promise<LocalAgentThreadProjectFolderUpdateResult> {
    const request = parseThreadAccessRequest(value);
    if (!isRecord(value) || typeof value.cwd !== "string" || value.cwd.trim().length === 0) {
      throw new TypeError("local chat project folder is invalid");
    }
    await this.ensureAuthorizedScope(request);
    return this.manager.rebindThreadProjectFolder(
      request.runtimeId,
      request.generation,
      request,
      request.threadId,
      value.cwd,
    );
  }

  async listMcpServers(value: unknown): Promise<LocalAgentMcpServerSummary[]> {
    const request = parseMcpScopeRequest(value);
    await this.ensureAuthorizedScope(request.scope);
    return this.manager.listMcpServers(request.runtimeId, request.generation, request.scope);
  }

  async saveMcpServer(value: unknown): Promise<RuntimeMcpServerSummary[]> {
    if (!isRecord(value)) throw new TypeError("local MCP server request is invalid");
    const request = parseMcpScopeRequest(value);
    const server = parseLocalAgentMcpServerDefinition(value.server);
    assertLocalAgentPayloadSize(server);
    await this.ensureAuthorizedScope(request.scope);
    return this.manager.saveMcpServer(request.runtimeId, request.generation, request.scope, server);
  }

  async removeMcpServer(value: unknown): Promise<RuntimeMcpServerSummary[]> {
    if (!isRecord(value) || typeof value.name !== "string") {
      throw new TypeError("local MCP server identity is invalid");
    }
    const request = parseMcpScopeRequest(value);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value.name)) {
      throw new TypeError("local MCP server identity is invalid");
    }
    await this.ensureAuthorizedScope(request.scope);
    return this.manager.removeMcpServer(request.runtimeId, request.generation, request.scope, value.name);
  }

  async request(value: unknown): Promise<LocalAgentJsonValue> {
    if (!isRecord(value)) throw new TypeError("local agent bridge request is invalid");
    const connection = parseBridgeConnection(value);
    const requestId = parseRequestId(value.requestId);
    const operationId = parseOptionalOperationId(value.operationId);
    const rpc = parseLocalAgentRpcRequest({
      id: requestId,
      method: value.method,
      params: value.params,
    });
    assertLocalAgentPayloadSize(rpc);
    const context = parseLocalAgentRequestContext(value.context);
    await this.ensureAuthorizedRuntime(connection);
    this.manager.assertReady(connection.runtimeId, connection.generation);
    if (rpc.method === "model/list") return this.modelCatalog.listModels();
    return this.manager.request(connection.runtimeId, connection.generation, rpc, context, operationId);
  }

  async getOperationOutcome(value: unknown): Promise<LocalAgentOperationOutcome> {
    if (!isRecord(value) || typeof value.operationId !== "string") {
      throw new TypeError("local operation identity is invalid");
    }
    const request = parseMcpScopeRequest(value);
    if (value.operationId.trim().length === 0 || value.operationId.length > 256) {
      throw new TypeError("local operation identity is invalid");
    }
    await this.ensureAuthorizedScope(request.scope);
    return this.manager.getOperationOutcome(
      request.runtimeId,
      request.generation,
      request.scope,
      value.operationId,
    );
  }

  async reply(value: unknown): Promise<void> {
    if (!isRecord(value)) throw new TypeError("local agent approval reply is invalid");
    const connection = parseBridgeConnection(value);
    const requestId = parseRequestId(value.requestId);
    const threadId = parseApprovalThreadId(value.threadId);
    const result = parseLocalAgentJsonObject(value.result);
    assertLocalAgentPayloadSize(result);
    await this.ensureAuthorizedRuntime(connection);
    await this.manager.reply(connection.runtimeId, connection.generation, requestId, threadId, result);
  }

  async provideToken(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.accessToken !== "string") {
      throw new TypeError("local agent token reply is invalid");
    }
    const connection = parseBridgeConnection(value);
    const pendingRequest = this.tokenBroker.getPendingRequest(value.requestId);
    if (!pendingRequest || pendingRequest.runtimeId !== connection.runtimeId ||
        pendingRequest.generation !== connection.generation) {
      throw new Error("Local model token request is no longer pending.");
    }
    try {
      await this.verifyAccessTokenForScope(pendingRequest, value.accessToken);
    } catch (cause) {
      this.tokenBroker.rejectRequest(value.requestId, new Error(SCOPE_VERIFICATION_ERROR));
      throw cause;
    }
    const accepted = this.tokenBroker.provideToken({
      ...connection,
      requestId: value.requestId,
      accessToken: value.accessToken,
    });
    if (!accepted) {
      this.tokenBroker.rejectRequest(value.requestId, new Error(SCOPE_VERIFICATION_ERROR));
      throw new Error("Local model token request is no longer pending.");
    }
  }

  onEvent(listener: (event: LocalAgentEvent) => void): () => void {
    return this.manager.onEvent(listener);
  }

  onTokenRequest(listener: (request: LocalAgentTokenRequest) => void): () => void {
    return this.tokenBroker.onRequest(listener);
  }

  async shutdown(): Promise<void> {
    this.tokenBroker.cancelAll();
    await this.manager.shutdownAll();
    await Promise.all([...this.activeRelays.keys()].map((key) => this.stopRelay(key)));
    this.authorizedScopes.clear();
    this.scopeAuthorizationPromises.clear();
    this.verifiedScopeTokens.clear();
  }

  async logout(accountIdValue: unknown): Promise<void> {
    const accountId = parseAccountId(accountIdValue);
    for (const [scopeKey, grant] of this.authorizedScopes) {
      if (grant.scope.accountId === accountId) this.authorizedScopes.delete(scopeKey);
    }
    for (const [tokenKey, grant] of this.verifiedScopeTokens) {
      if (grant.scope.accountId === accountId) this.verifiedScopeTokens.delete(tokenKey);
    }
    this.tokenBroker.cancelAccount(accountId);
    await this.manager.stopAccount(accountId);
    const relayKeys = [...this.activeRelays.entries()]
      .filter(([, relay]) => relay.accountId === accountId)
      .map(([key]) => key);
    await Promise.all(relayKeys.map((key) => this.stopRelay(key)));
  }

  private requireBundle(): VerifiedLocalAgentBundle {
    if (!this.bundle) throw new Error(this.bundleError ?? "Bundled Cerebrum runtime is unavailable.");
    return this.bundle;
  }

  private async ensureAuthorizedRuntime(connection: ParsedBridgeConnection): Promise<void> {
    await this.ensureAuthorizedScope(this.manager.getRuntimeScope(connection.runtimeId, connection.generation));
  }

  private async ensureAuthorizedScope(scopeValue: unknown): Promise<ReturnType<typeof parseLocalAgentRuntimeScope>> {
    const scope = parseLocalAgentRuntimeScope(scopeValue);
    const scopeKey = createScopeAuthorizationKey(scope);
    const existingGrant = this.authorizedScopes.get(scopeKey);
    if (existingGrant && existingGrant.expiresAt > Date.now()) return { ...existingGrant.scope };

    let authorization = this.scopeAuthorizationPromises.get(scopeKey);
    if (!authorization) {
      authorization = this.verifyScopeAuthorization(scope);
      this.scopeAuthorizationPromises.set(scopeKey, authorization);
    }
    try {
      await authorization;
      return { ...scope };
    } finally {
      if (this.scopeAuthorizationPromises.get(scopeKey) === authorization) {
        this.scopeAuthorizationPromises.delete(scopeKey);
      }
    }
  }

  private async verifyScopeAuthorization(scope: ReturnType<typeof parseLocalAgentRuntimeScope>): Promise<void> {
    const runtimeId = `scope-auth:${randomUUID()}`;
    const accessToken = await this.tokenBroker.requestToken({ ...scope, runtimeId, generation: 0 }, false);
    const tokenKey = createScopeTokenKey(scope, accessToken);
    if ((this.verifiedScopeTokens.get(tokenKey)?.expiresAt ?? 0) <= Date.now()) {
      throw new Error(SCOPE_VERIFICATION_ERROR);
    }
  }

  private async verifyAccessTokenForScope(
    request: LocalAgentTokenRequest,
    accessToken: string,
  ): Promise<void> {
    if (!isLocalAgentAccessToken(accessToken)) throw new Error(SCOPE_VERIFICATION_ERROR);
    const scope = parseLocalAgentRuntimeScope(request);
    const tokenKey = createScopeTokenKey(scope, accessToken);
    const existingTokenGrant = this.verifiedScopeTokens.get(tokenKey);
    if (existingTokenGrant && existingTokenGrant.expiresAt > Date.now()) {
      this.authorizedScopes.set(createScopeAuthorizationKey(scope), {
        scope: { ...scope },
        expiresAt: Date.now() + SCOPE_AUTHORIZATION_TTL_MS,
      });
      return;
    }

    const response = await this.fetcher(new URL(DESKTOP_SCOPE_VERIFICATION_PATH, this.apiOrigin), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "x-ardor-workspace-id": scope.workspaceId,
      },
      redirect: "error",
      signal: AbortSignal.timeout(SCOPE_VERIFICATION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(SCOPE_VERIFICATION_ERROR);

    let verifiedScope: unknown;
    try {
      verifiedScope = await response.json();
    } catch {
      throw new Error(SCOPE_VERIFICATION_ERROR);
    }
    if (!isRecord(verifiedScope) || verifiedScope.account_id !== scope.accountId ||
        verifiedScope.workspace_id !== scope.workspaceId || typeof verifiedScope.expires_at !== "number" ||
        !Number.isSafeInteger(verifiedScope.expires_at)) {
      throw new Error(SCOPE_VERIFICATION_ERROR);
    }

    const now = Date.now();
    const tokenExpiresAt = verifiedScope.expires_at * 1000;
    if (tokenExpiresAt <= now) throw new Error(SCOPE_VERIFICATION_ERROR);
    const expiresAt = Math.min(now + SCOPE_AUTHORIZATION_TTL_MS, tokenExpiresAt);
    this.authorizedScopes.set(createScopeAuthorizationKey(scope), {
      scope: { ...scope },
      expiresAt,
    });
    this.verifiedScopeTokens.set(tokenKey, { scope: { ...scope }, expiresAt });
    trimExpiredScopeGrants(this.authorizedScopes);
    trimExpiredScopeGrants(this.verifiedScopeTokens);
  }

  private async stopRelay(runtimeKey: string): Promise<void> {
    const active = this.activeRelays.get(runtimeKey);
    if (!active) return;
    this.activeRelays.delete(runtimeKey);
    await active.relay.stop();
  }
}

function assertLocalAgentPayloadSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value)) > LOCAL_AGENT_IPC_MAX_BYTES) {
    throw new RangeError("Local Cerebrum IPC payload is too large.");
  }
}

function writeRuntimeProviderConfig(runtimeHome: string, relayPort: number): void {
  const resolvedHome = resolve(runtimeHome);
  mkdirSync(resolvedHome, { recursive: true, mode: 0o700 });
  const configPath = resolve(resolvedHome, "config.toml");
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, buildLocalAgentProviderConfig(relayPort), { mode: 0o600 });
  try {
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Keep the original write error; the temporary file is private to this runtime.
    }
    throw error;
  }
}

function parseAccountId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new TypeError("Local agent account identity is invalid.");
  }
  return value;
}

function parseBridgeConnection(value: Record<string, unknown>): ParsedBridgeConnection {
  if (typeof value.runtimeId !== "string" || value.runtimeId.length < 1 || value.runtimeId.length > 256 ||
      typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw new TypeError("local agent runtime identity is invalid");
  }
  return { runtimeId: value.runtimeId, generation: value.generation };
}

function parseRequestId(value: unknown): string | number {
  if ((typeof value === "string" && value.length > 0 && value.length <= LOCAL_REQUEST_ID_MAX_LENGTH) ||
      (typeof value === "number" && Number.isSafeInteger(value))) {
    return value;
  }
  throw new TypeError("local agent request identity is invalid");
}

function parseApprovalThreadId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new TypeError("local chat identity is invalid");
  }
  return value;
}

function parseOptionalOperationId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new TypeError("local operation identity is invalid");
  }
  return value;
}

function parseThreadAccessRequest(value: unknown): LocalAgentThreadAccessRequest {
  if (!isRecord(value) || typeof value.threadId !== "string" || value.threadId.trim().length === 0 ||
      value.threadId.length > 128) {
    throw new TypeError("local chat identity is invalid");
  }
  const scope = parseLocalAgentRuntimeScope(value);
  const connection = parseBridgeConnection(value);
  return { ...scope, ...connection, threadId: value.threadId };
}

function parseMcpScopeRequest(
  value: unknown,
): ParsedBridgeConnection & { readonly scope: ReturnType<typeof parseLocalAgentRuntimeScope> } {
  if (!isRecord(value)) throw new TypeError("local MCP runtime scope is invalid");
  const scope = parseLocalAgentRuntimeScope(value);
  const connection = parseBridgeConnection(value);
  return { ...connection, scope };
}

function toConnection(handle: LocalAgentRuntimeHandle): LocalAgentConnection {
  return { runtimeId: handle.runtimeId, generation: handle.generation };
}

function getRuntimeKey(runtimeId: string, generation: number): string {
  return `${runtimeId}:${generation}`;
}

function createScopeAuthorizationKey(scope: ReturnType<typeof parseLocalAgentRuntimeScope>): string {
  return JSON.stringify([scope.accountId, scope.workspaceId]);
}

function createScopeTokenKey(scope: ReturnType<typeof parseLocalAgentRuntimeScope>, accessToken: string): string {
  const tokenDigest = createHash("sha256").update(accessToken).digest("hex");
  return JSON.stringify([createScopeAuthorizationKey(scope), tokenDigest]);
}

function trimExpiredScopeGrants<Grant extends { readonly expiresAt: number }>(grants: Map<string, Grant>): void {
  const now = Date.now();
  for (const [key, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(key);
  }
  while (grants.size > 256) {
    const oldestKey = grants.keys().next().value;
    if (oldestKey === undefined) break;
    grants.delete(oldestKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
