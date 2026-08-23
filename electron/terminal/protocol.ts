export const TERMINAL_BROKER_PROTOCOL_VERSION = 1 as const;

export const TERMINAL_LIMITS = Object.freeze({
  INPUT_FRAME_BYTES: 64 * 1024,
  MAX_SESSIONS_GLOBAL: 32,
  MAX_SESSIONS_PER_OWNER: 8,
  MAX_CWD_CODE_UNITS: 4096,
  MAX_DIMENSION: 500,
  MIN_DIMENSION: 2,
  OUTPUT_BATCH_BYTES: 64 * 1024,
  OUTPUT_BATCH_MS: 16,
  PAUSE_HIGH_WATER_BYTES: 512 * 1024,
  REPLAY_BYTES: 1024 * 1024,
  RESUME_LOW_WATER_BYTES: 128 * 1024,
});

interface TerminalRequestEnvelope {
  brokerId: string;
  protocolVersion: typeof TERMINAL_BROKER_PROTOCOL_VERSION;
  requestId: string;
}

interface GenerationBoundTerminalRequest extends TerminalRequestEnvelope {
  commandSequence: number;
  generation: number;
  ownerId: number;
  terminalId: string;
}

export interface TerminalOpenRequest extends TerminalRequestEnvelope {
  cols: number;
  cwd?: string;
  ownerId: number;
  profileId?: TerminalShellProfileId;
  rows: number;
  terminalId: string;
  type: "open";
}

export interface TerminalDetachRequest extends GenerationBoundTerminalRequest {
  type: "detach";
}

export interface TerminalWriteRequest extends GenerationBoundTerminalRequest {
  data: string;
  type: "write";
}

export interface TerminalResizeRequest extends GenerationBoundTerminalRequest {
  cols: number;
  rows: number;
  type: "resize";
}

export interface TerminalAckRequest extends GenerationBoundTerminalRequest {
  sequence: number;
  type: "ack";
}

export interface TerminalRestartRequest extends GenerationBoundTerminalRequest {
  cols?: number;
  cwd?: string;
  profileId?: TerminalShellProfileId;
  rows?: number;
  type: "restart";
}

export interface TerminalCloseRequest extends GenerationBoundTerminalRequest {
  type: "close";
}

export interface TerminalClearRequest extends GenerationBoundTerminalRequest {
  type: "clear";
}

export interface TerminalCloseOwnerRequest extends TerminalRequestEnvelope {
  ownerId: number;
  type: "closeOwner";
}

export interface TerminalShutdownRequest extends TerminalRequestEnvelope {
  type: "shutdown";
}

export interface TerminalListProfilesRequest extends TerminalRequestEnvelope {
  type: "listProfiles";
}

export const TERMINAL_BROKER_ERROR_CODES = Object.freeze({
  BROKER_UNAVAILABLE: "BROKER_UNAVAILABLE",
  INTERNAL: "INTERNAL",
  INVALID_CWD: "INVALID_CWD",
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  OWNER_MISMATCH: "OWNER_MISMATCH",
  SESSION_LIMIT: "SESSION_LIMIT",
  SHELL_UNAVAILABLE: "SHELL_UNAVAILABLE",
  SPAWN_FAILED: "SPAWN_FAILED",
  STALE_COMMAND: "STALE_COMMAND",
  STALE_GENERATION: "STALE_GENERATION",
} as const);

export type TerminalBrokerErrorCode = typeof TERMINAL_BROKER_ERROR_CODES[keyof typeof TERMINAL_BROKER_ERROR_CODES];

export interface TerminalReplayChunk {
  readonly data: string;
  readonly sequence: number;
}

export interface TerminalSnapshot {
  brokerId: string;
  cols: number;
  cwd: string;
  exitCode: number | null;
  generation: number;
  ownerId: number;
  profileId: TerminalShellProfileId;
  readonly replay: readonly TerminalReplayChunk[];
  rows: number;
  sequence: number;
  shell: string;
  status: "exited" | "running";
  terminalId: string;
  truncated: boolean;
}

export interface TerminalDataEvent {
  data: string;
  generation: number;
  ownerId: number;
  sequence: number;
  terminalId: string;
  type: "data";
}

export interface TerminalExitEvent {
  exitCode: number | null;
  generation: number;
  ownerId: number;
  sequence: number;
  terminalId: string;
  type: "exit";
}

export interface TerminalServiceLostEvent {
  generation: number;
  ownerId: number;
  reason: string;
  sequence: number;
  terminalId: string;
  type: "service-lost";
}

export type TerminalEvent = TerminalDataEvent | TerminalExitEvent | TerminalServiceLostEvent;

interface TerminalMessageEnvelope {
  brokerId: string;
  protocolVersion: typeof TERMINAL_BROKER_PROTOCOL_VERSION;
}

export interface TerminalReadyMessage extends TerminalMessageEnvelope {
  type: "ready";
}

export interface TerminalEventMessage extends TerminalMessageEnvelope {
  event: TerminalEvent;
  type: "event";
}

interface TerminalResponseEnvelope extends TerminalMessageEnvelope {
  requestId: string;
  requestType: TerminalRequestType;
  type: "response";
}

export type TerminalSuccessfulResponse = TerminalResponseEnvelope & (
  | { ok: true; requestType: "open" | "restart"; snapshot: TerminalSnapshot }
  | { catalog: TerminalShellProfileCatalog; ok: true; requestType: "listProfiles" }
  | { ok: true; requestType: Exclude<TerminalRequestType, "listProfiles" | "open" | "restart"> }
);

export interface TerminalFailedResponse extends TerminalResponseEnvelope {
  error: {
    code: TerminalBrokerErrorCode;
    message: string;
  };
  ok: false;
}

export type TerminalBrokerRequest =
  | TerminalAckRequest
  | TerminalClearRequest
  | TerminalCloseOwnerRequest
  | TerminalCloseRequest
  | TerminalDetachRequest
  | TerminalListProfilesRequest
  | TerminalOpenRequest
  | TerminalResizeRequest
  | TerminalRestartRequest
  | TerminalShutdownRequest
  | TerminalWriteRequest;
export type TerminalRequestType = TerminalBrokerRequest["type"];
export type TerminalResponseMessage = TerminalFailedResponse | TerminalSuccessfulResponse;
export type TerminalBrokerMessage = TerminalEventMessage | TerminalReadyMessage | TerminalResponseMessage;

const utf8Encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWellFormedString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return isWellFormedString(value) && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isDimension(value: unknown): value is number {
  return isPositiveSafeInteger(value)
    && value >= TERMINAL_LIMITS.MIN_DIMENSION
    && value <= TERMINAL_LIMITS.MAX_DIMENSION;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasValidEnvelope(value: Record<string, unknown>): boolean {
  return value.protocolVersion === TERMINAL_BROKER_PROTOCOL_VERSION
    && isNonEmptyString(value.brokerId);
}

export function utf8ByteLength(value: string): number {
  if (!isWellFormedString(value)) {
    throw new TypeError("value must be a well-formed UTF-16 string");
  }
  return utf8Encoder.encode(value).byteLength;
}

export function takeUtf8Tail(value: string, maxBytes: number): { dropped: boolean; value: string } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  if (utf8ByteLength(value) <= maxBytes) return { dropped: false, value };
  if (maxBytes <= 0) return { dropped: value.length > 0, value: "" };

  let bytes = 0;
  let start = value.length;
  while (start > 0) {
    let nextStart = start - 1;
    const trailingUnit = value.charCodeAt(nextStart);
    if (
      trailingUnit >= 0xdc00
      && trailingUnit <= 0xdfff
      && nextStart > 0
      && value.charCodeAt(nextStart - 1) >= 0xd800
      && value.charCodeAt(nextStart - 1) <= 0xdbff
    ) {
      nextStart -= 1;
    }
    const codePointBytes = utf8ByteLength(value.slice(nextStart, start));
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    start = nextStart;
  }
  return { dropped: start > 0, value: value.slice(start) };
}

function hasValidRequestEnvelope(value: Record<string, unknown>): boolean {
  return hasValidEnvelope(value) && isNonEmptyString(value.requestId);
}

function isValidCwd(value: unknown): value is string | undefined {
  return value === undefined
    || (isWellFormedString(value) && value.length <= TERMINAL_LIMITS.MAX_CWD_CODE_UNITS);
}

function isValidProfileId(value: unknown): value is TerminalShellProfileId | undefined {
  return value === undefined || isTerminalShellProfileId(value);
}

function isTerminalShellProfileCatalog(value: unknown): value is TerminalShellProfileCatalog {
  if (!isRecord(value) || !hasOnlyKeys(value, ["defaultProfileId", "profiles"])) return false;
  if (!Array.isArray(value.profiles)) return false;
  if (value.defaultProfileId !== null && !isTerminalShellProfileId(value.defaultProfileId)) return false;
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const profile of value.profiles) {
    if (
      !isRecord(profile)
      || !hasOnlyKeys(profile, ["id", "label"])
      || !isTerminalShellProfileId(profile.id)
      || !isNonEmptyString(profile.label)
      || profile.label.length > 128
      || ids.has(profile.id)
      || labels.has(profile.label)
    ) return false;
    ids.add(profile.id);
    labels.add(profile.label);
  }
  return value.defaultProfileId === null
    ? value.profiles.length === 0
    : ids.has(value.defaultProfileId);
}

function hasValidOrderedIdentity(value: Record<string, unknown>): boolean {
  return isPositiveSafeInteger(value.ownerId)
    && isNonEmptyString(value.terminalId)
    && isPositiveSafeInteger(value.generation)
    && isPositiveSafeInteger(value.commandSequence);
}

function orderedKeys(...payloadKeys: string[]): string[] {
  return [
    "brokerId",
    "commandSequence",
    "generation",
    "ownerId",
    "protocolVersion",
    "requestId",
    "terminalId",
    "type",
    ...payloadKeys,
  ];
}

export function isTerminalBrokerRequest(value: unknown): value is TerminalBrokerRequest {
  if (!isRecord(value) || !hasValidRequestEnvelope(value)) return false;
  switch (value.type) {
    case "open":
      return hasOnlyKeys(value, ["brokerId", "cols", "cwd", "ownerId", "profileId", "protocolVersion", "requestId", "rows", "terminalId", "type"])
        && isPositiveSafeInteger(value.ownerId)
        && isNonEmptyString(value.terminalId)
        && isDimension(value.cols)
        && isDimension(value.rows)
        && isValidCwd(value.cwd)
        && isValidProfileId(value.profileId);
    case "detach":
    case "close":
    case "clear":
      return hasOnlyKeys(value, orderedKeys()) && hasValidOrderedIdentity(value);
    case "write":
      return hasOnlyKeys(value, orderedKeys("data"))
        && hasValidOrderedIdentity(value)
        && isWellFormedString(value.data)
        && utf8ByteLength(value.data) <= TERMINAL_LIMITS.INPUT_FRAME_BYTES;
    case "resize":
      return hasOnlyKeys(value, orderedKeys("cols", "rows"))
        && hasValidOrderedIdentity(value)
        && isDimension(value.cols)
        && isDimension(value.rows);
    case "ack":
      return hasOnlyKeys(value, orderedKeys("sequence"))
        && hasValidOrderedIdentity(value)
        && isPositiveSafeInteger(value.sequence);
    case "restart":
      return hasOnlyKeys(value, orderedKeys("cols", "cwd", "profileId", "rows"))
        && hasValidOrderedIdentity(value)
        && (value.cols === undefined || isDimension(value.cols))
        && (value.rows === undefined || isDimension(value.rows))
        && isValidCwd(value.cwd)
        && isValidProfileId(value.profileId);
    case "listProfiles":
      return hasOnlyKeys(value, ["brokerId", "protocolVersion", "requestId", "type"]);
    case "closeOwner":
      return hasOnlyKeys(value, ["brokerId", "ownerId", "protocolVersion", "requestId", "type"])
        && isPositiveSafeInteger(value.ownerId);
    case "shutdown":
      return hasOnlyKeys(value, ["brokerId", "protocolVersion", "requestId", "type"]);
    default:
      return false;
  }
}

const REQUEST_TYPES = new Set<TerminalRequestType>([
  "ack",
  "clear",
  "close",
  "closeOwner",
  "detach",
  "listProfiles",
  "open",
  "resize",
  "restart",
  "shutdown",
  "write",
]);
const ERROR_CODES = new Set<TerminalBrokerErrorCode>(Object.values(TERMINAL_BROKER_ERROR_CODES));

function isTerminalSnapshot(value: unknown, brokerId: string): value is TerminalSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "brokerId", "cols", "cwd", "exitCode", "generation", "ownerId", "profileId", "replay", "rows",
    "sequence", "shell", "status", "terminalId", "truncated",
  ])) return false;
  if (
    value.brokerId !== brokerId
    || !isDimension(value.cols)
    || !isValidCwd(value.cwd)
    || typeof value.cwd !== "string"
    || !isPositiveSafeInteger(value.generation)
    || !isPositiveSafeInteger(value.ownerId)
    || !isTerminalShellProfileId(value.profileId)
    || !Array.isArray(value.replay)
    || !isDimension(value.rows)
    || !(typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence >= 0)
    || !isNonEmptyString(value.shell)
    || (value.status !== "running" && value.status !== "exited")
    || !isNonEmptyString(value.terminalId)
    || typeof value.truncated !== "boolean"
    || !(value.exitCode === null || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)))
    || (value.status === "running" && value.exitCode !== null)
  ) return false;

  let bytes = 0;
  let previousSequence = 0;
  for (const chunk of value.replay) {
    if (
      !isRecord(chunk)
      || !hasOnlyKeys(chunk, ["data", "sequence"])
      || !isNonEmptyString(chunk.data)
      || !isPositiveSafeInteger(chunk.sequence)
      || chunk.sequence <= previousSequence
      || chunk.sequence > value.sequence
    ) return false;
    bytes += utf8ByteLength(chunk.data);
    if (bytes > TERMINAL_LIMITS.REPLAY_BYTES) return false;
    previousSequence = chunk.sequence;
  }
  return true;
}

function hasValidEventIdentity(value: Record<string, unknown>): boolean {
  return isPositiveSafeInteger(value.ownerId)
    && isNonEmptyString(value.terminalId)
    && isPositiveSafeInteger(value.generation)
    && isPositiveSafeInteger(value.sequence);
}

function isTerminalEvent(value: unknown): value is TerminalEvent {
  if (!isRecord(value) || !hasValidEventIdentity(value)) return false;
  const identityKeys = ["generation", "ownerId", "sequence", "terminalId", "type"];
  switch (value.type) {
    case "data":
      return hasOnlyKeys(value, [...identityKeys, "data"])
        && isNonEmptyString(value.data)
        && utf8ByteLength(value.data) <= TERMINAL_LIMITS.OUTPUT_BATCH_BYTES;
    case "exit":
      return hasOnlyKeys(value, [...identityKeys, "exitCode"])
        && (value.exitCode === null || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)));
    case "service-lost":
      return hasOnlyKeys(value, [...identityKeys, "reason"])
        && isNonEmptyString(value.reason);
    default:
      return false;
  }
}

export function isTerminalBrokerMessage(value: unknown): value is TerminalBrokerMessage {
  if (!isRecord(value) || !hasValidEnvelope(value)) return false;
  if (value.type === "ready") return hasOnlyKeys(value, ["brokerId", "protocolVersion", "type"]);
  if (value.type === "event") {
    return hasOnlyKeys(value, ["brokerId", "event", "protocolVersion", "type"])
      && isTerminalEvent(value.event);
  }
  if (
    value.type !== "response"
    || !isNonEmptyString(value.requestId)
    || typeof value.requestType !== "string"
    || !REQUEST_TYPES.has(value.requestType as TerminalRequestType)
  ) return false;
  if (value.ok === false) {
    return hasOnlyKeys(value, ["brokerId", "error", "ok", "protocolVersion", "requestId", "requestType", "type"])
      && isRecord(value.error)
      && hasOnlyKeys(value.error, ["code", "message"])
      && typeof value.error.code === "string"
      && ERROR_CODES.has(value.error.code as TerminalBrokerErrorCode)
      && isNonEmptyString(value.error.message);
  }
  if (value.ok !== true) return false;
  if (value.requestType === "open" || value.requestType === "restart") {
    return hasOnlyKeys(value, ["brokerId", "ok", "protocolVersion", "requestId", "requestType", "snapshot", "type"])
      && isTerminalSnapshot(value.snapshot, value.brokerId as string);
  }
  if (value.requestType === "listProfiles") {
    return hasOnlyKeys(value, ["brokerId", "catalog", "ok", "protocolVersion", "requestId", "requestType", "type"])
      && isTerminalShellProfileCatalog(value.catalog);
  }
  return hasOnlyKeys(value, ["brokerId", "ok", "protocolVersion", "requestId", "requestType", "type"]);
}
import {
  isTerminalShellProfileId,
  type TerminalShellProfileCatalog,
  type TerminalShellProfileId,
} from "./shell-profile.js";
