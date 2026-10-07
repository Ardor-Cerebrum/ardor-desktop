import { posix, win32 } from "node:path";

export const LOCAL_AGENT_RPC_METHODS = [
  "initialize",
  "thread/start",
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
  "thread/list",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/fork",
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
  "model/list",
  "collaborationMode/list",
  "experimentalFeature/list",
  "fs/readFile",
  "fs/readDirectory",
  "fs/createDirectory",
  "fs/writeFile",
  "fs/remove",
  "fuzzyFileSearch",
  "fuzzyFileSearch/sessionStart",
  "fuzzyFileSearch/sessionUpdate",
  "fuzzyFileSearch/sessionStop",
  "skills/list",
  "plugin/installed",
  "mcpServerStatus/list",
  "mcpServer/resource/read",
  "command/exec",
  "thread/revert",
  "thread/inject_items",
] as const;

export type LocalAgentRpcMethod = (typeof LOCAL_AGENT_RPC_METHODS)[number];
export type LocalAgentJsonValue =
  | null
  | boolean
  | number
  | string
  | LocalAgentJsonValue[]
  | { [key: string]: LocalAgentJsonValue };

export interface LocalAgentRpcRequest {
  readonly id: number | string;
  readonly method: LocalAgentRpcMethod;
  readonly params: { readonly [key: string]: LocalAgentJsonValue };
}

export interface LocalAgentRuntimeScope {
  readonly accountId: string;
  readonly workspaceId: string;
}

export interface LocalAgentRequestContext {
  readonly cwd?: string;
  readonly threadId?: string;
}

const localAgentRpcMethodSet = new Set<string>(LOCAL_AGENT_RPC_METHODS);

export function parseLocalAgentRpcRequest(value: unknown): LocalAgentRpcRequest {
  if (!isRecord(value) || !isRpcId(value.id) || typeof value.method !== "string") {
    throw new TypeError("local agent RPC request is invalid");
  }
  if (!isLocalAgentRpcMethod(value.method) || !isJsonObject(value.params)) {
    throw new TypeError("local agent RPC method or params are invalid");
  }

  return {
    id: value.id,
    method: value.method,
    params: value.params,
  };
}

export function parseLocalAgentRuntimeScope(value: unknown): LocalAgentRuntimeScope {
  if (!isRecord(value) || !isNonEmptyString(value.accountId) || !isNonEmptyString(value.workspaceId)) {
    throw new TypeError("local agent account and workspace scope are required");
  }

  return { accountId: value.accountId, workspaceId: value.workspaceId };
}

export function parseLocalAgentRequestContext(value: unknown): LocalAgentRequestContext {
  if (value === undefined) return {};
  if (!isRecord(value) ||
      (value.cwd !== undefined && !isNonEmptyString(value.cwd)) ||
      (value.threadId !== undefined && !isNonEmptyString(value.threadId))) {
    throw new TypeError("local agent request context is invalid");
  }
  return {
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
  };
}

export function parseLocalAgentJsonObject(value: unknown): Record<string, LocalAgentJsonValue> {
  if (!isJsonObject(value)) {
    throw new TypeError("local agent JSON object is invalid");
  }
  return value;
}

export function resolveLocalProjectPath(value: unknown, platform: NodeJS.Platform): string {
  if (!isNonEmptyString(value)) {
    throw new TypeError("local project path is invalid");
  }

  const pathApi = platform === "win32" ? win32 : posix;
  const isAbsolutePath = platform === "win32"
    ? /^[A-Za-z]:[\\/]+/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
    : pathApi.isAbsolute(value);
  if (!isAbsolutePath) {
    throw new TypeError("local project path must be absolute");
  }
  return pathApi.normalize(value);
}

function isJsonObject(value: unknown): value is { [key: string]: LocalAgentJsonValue } {
  if (!isRecord(value)) return false;
  const ancestors = new WeakSet<object>([value]);
  return Object.entries(value).every(([key, item]) =>
    key !== "__proto__" && isJsonValue(item, 0, ancestors),
  );
}

function isLocalAgentRpcMethod(value: string): value is LocalAgentRpcMethod {
  return localAgentRpcMethodSet.has(value);
}

function isJsonValue(value: unknown, depth: number, ancestors: WeakSet<object>): value is LocalAgentJsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const entries = Object.entries(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, depth + 1, ancestors))
    : entries.every(([key, item]) => key !== "__proto__" && isJsonValue(item, depth + 1, ancestors));
  ancestors.delete(value);
  return valid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is number | string {
  return (typeof value === "string" && value.length > 0 && value.length <= 256) ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}
