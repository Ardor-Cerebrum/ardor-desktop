import { TextDecoder } from "node:util";

import { parseLocalAgentJsonObject, type LocalAgentJsonValue } from "./protocol.js";

const MODEL_CATALOG_PATH = "/haron-api/api/cerebrum/desktop/models";
const RUNTIME_MODEL_CATALOG_PATH = "/haron-api/api/cerebrum/models";
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODEL_COUNT = 100;
const MODEL_MODALITIES = new Set(["text", "image", "audio"]);
const MULTI_AGENT_VERSIONS = new Set(["disabled", "v1", "v2"]);
const APPLY_PATCH_TOOL_TYPES = new Set<LocalAgentJsonValue>([null, "freeform", "function"]);
const TOOL_MODES = new Set<LocalAgentJsonValue>([null, "direct", "code_mode_only", "code_mode_with_direct_tools"]);

export interface LocalModelCatalogClientOptions {
  readonly apiOrigin: string;
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
}

export interface LocalRuntimeModelCatalog {
  readonly modelList: Record<string, LocalAgentJsonValue>;
  readonly runtimeCatalog: Record<string, LocalAgentJsonValue>;
}

/** Loads the server-owned, app-server-compatible model catalog for local chats. */
export class LocalModelCatalogClient {
  private readonly apiOrigin: string;
  private readonly fetcher: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(options: LocalModelCatalogClientOptions) {
    this.apiOrigin = validateApiOrigin(options.apiOrigin);
    this.fetcher = options.fetch ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 ||
        this.maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES) {
      throw new RangeError("Haron model catalog response limit is invalid.");
    }
  }

  async listModels(): Promise<Record<string, LocalAgentJsonValue>> {
    return parseCatalog(await this.loadJson(MODEL_CATALOG_PATH));
  }

  async loadRuntimeCatalog(): Promise<LocalRuntimeModelCatalog> {
    const [modelList, value] = await Promise.all([
      this.listModels(), this.loadJson(RUNTIME_MODEL_CATALOG_PATH),
    ]);
    const native = parseLocalAgentJsonObject(value);
    if (!Array.isArray(native.models) || native.models.length > MAX_MODEL_COUNT || !Array.isArray(modelList.data)) {
      throw new Error("Haron runtime model catalog is incompatible.");
    }
    const bySlug = new Map<string, Record<string, LocalAgentJsonValue>>();
    for (const entry of native.models) {
      const model = parseLocalAgentJsonObject(entry);
      if (!isBoundedString(model.slug, 256) || bySlug.has(model.slug) ||
          !isBoundedString(model.base_instructions, 128 * 1024) ||
          !APPLY_PATCH_TOOL_TYPES.has(model.apply_patch_tool_type) ||
          !TOOL_MODES.has(model.tool_mode)) {
        throw new Error("Haron runtime model capabilities are incompatible.");
      }
      bySlug.set(model.slug, model);
    }
    const models = modelList.data.map((entry) => {
      const model = parseLocalAgentJsonObject(entry);
      const metadata = typeof model.id === "string" ? bySlug.get(model.id) : undefined;
      if (!metadata) throw new Error("Haron runtime metadata is missing for an offered model.");
      return metadata;
    });
    return { modelList, runtimeCatalog: { models } };
  }

  private async loadJson(path: string): Promise<unknown> {
    const response = await this.fetcher(new URL(path, this.apiOrigin), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Haron model catalog is unavailable.");

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > this.maxResponseBytes) {
      await response.body?.cancel();
      throw new Error("Haron model catalog response is too large.");
    }

    const body = await readBoundedResponseText(response, this.maxResponseBytes);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new Error("Haron model catalog response is invalid.");
    }
    return value;
  }
}

function parseCatalog(value: unknown): Record<string, LocalAgentJsonValue> {
  const record = parseLocalAgentJsonObject(value);
  if (!Array.isArray(record.data) || record.data.length > MAX_MODEL_COUNT || record.nextCursor !== null) {
    throw new Error("Haron model catalog response is incompatible.");
  }
  const models = record.data.map(parseModel);
  if (models.filter((model) => model.isDefault === true).length !== 1) {
    throw new Error("Haron model catalog must declare exactly one default model.");
  }
  return { data: models, nextCursor: null };
}

function parseModel(value: unknown): Record<string, LocalAgentJsonValue> {
  if (!isRecord(value) || !isBoundedString(value.id, 256) || !isBoundedString(value.model, 256) ||
      value.id !== value.model || value.upgrade !== null || value.upgradeInfo !== null ||
      !isNullableMessage(value.availabilityNux) || !isBoundedString(value.displayName, 200) ||
      !isBoundedString(value.description, 2000) || !isNullableString(value.modelSpecialty, 200) ||
      value.hidden !== false || !isBoundedArray(value.supportedReasoningEfforts, parseReasoningEffort) ||
      !isBoundedString(value.defaultReasoningEffort, 32) ||
      !isModalities(value.inputModalities) || value.supportsPersonality !== false ||
      typeof value.multiAgentVersion !== "string" || !MULTI_AGENT_VERSIONS.has(value.multiAgentVersion) ||
      !isStringArray(value.additionalSpeedTiers, 32) || !isBoundedArray(value.serviceTiers, parseServiceTier) ||
      !isNullableString(value.defaultServiceTier, 64) || value.availableAccessPrograms !== null ||
      typeof value.isDefault !== "boolean") {
    throw new Error("Haron model catalog contains an invalid model.");
  }

  return {
    id: value.id,
    model: value.model,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: value.availabilityNux === null ? null : { message: value.availabilityNux.message },
    displayName: value.displayName,
    description: value.description,
    modelSpecialty: value.modelSpecialty,
    hidden: false,
    supportedReasoningEfforts: value.supportedReasoningEfforts.map(parseReasoningEffort),
    defaultReasoningEffort: value.defaultReasoningEffort,
    inputModalities: value.inputModalities,
    supportsPersonality: false,
    multiAgentVersion: value.multiAgentVersion,
    additionalSpeedTiers: value.additionalSpeedTiers,
    serviceTiers: value.serviceTiers.map(parseServiceTier),
    defaultServiceTier: value.defaultServiceTier,
    availableAccessPrograms: null,
    isDefault: value.isDefault,
  };
}

function parseReasoningEffort(value: unknown): Record<string, LocalAgentJsonValue> {
  if (!isRecord(value) || !isBoundedString(value.reasoningEffort, 32) ||
      !isBoundedString(value.description, 240)) {
    throw new Error("Haron model catalog reasoning metadata is invalid.");
  }
  return { reasoningEffort: value.reasoningEffort, description: value.description };
}

function parseServiceTier(value: unknown): Record<string, LocalAgentJsonValue> {
  if (!isRecord(value) || !isBoundedString(value.id, 64) || !isBoundedString(value.name, 100) ||
      !isBoundedString(value.description, 240)) {
    throw new Error("Haron model catalog service tier is invalid.");
  }
  return { id: value.id, name: value.name, description: value.description };
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) throw new Error("Haron model catalog response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error("Haron model catalog response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new Error("Haron model catalog response is not valid UTF-8.");
  }
}

function validateApiOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Desktop model gateway origin is invalid.");
  }
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableMessage(value: unknown): value is null | { readonly message: string } {
  return value === null || (isRecord(value) && isBoundedString(value.message, 2000));
}

function isNullableString(value: unknown, maximumLength: number): value is null | string {
  return value === null || isBoundedString(value, maximumLength);
}

function isModalities(value: unknown): value is LocalAgentJsonValue[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) =>
    typeof item === "string" && MODEL_MODALITIES.has(item),
  );
}

function isStringArray(value: unknown, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= 16 && value.every((item) => isBoundedString(item, maximumLength));
}

function isBoundedArray<T extends Record<string, LocalAgentJsonValue>>(
  value: unknown,
  parseItem: (item: unknown) => T,
): value is unknown[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  try {
    value.map(parseItem);
    return true;
  } catch {
    return false;
  }
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim().length > 0 && value.length <= maximumLength;
}
