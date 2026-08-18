import type {
  BrowserAgentConsoleMessage,
  BrowserAgentDiagnosticsReader,
  BrowserAgentNetworkRequest,
} from "./browser-surface";

const MAX_CONSOLE_ENTRIES = 500;
const MAX_CONSOLE_ENTRY_CHARS = 8_000;
const MAX_CONSOLE_TOTAL_CHARS = 2 * 1024 * 1024;
const MAX_NETWORK_ENTRIES = 500;
const MAX_RESPONSE_BODY_CHARS = 10 * 1024;

type DebuggerCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textFromRemoteObject(value: unknown): string {
  const remote = record(value);
  if (!remote) return String(value ?? "");
  if (typeof remote.value === "string") return remote.value;
  if (remote.value !== undefined) {
    try {
      return JSON.stringify(remote.value);
    } catch {
      return String(remote.value);
    }
  }
  if (typeof remote.description === "string") return remote.description;
  return typeof remote.type === "string" ? remote.type : "value";
}

function originOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function consoleLevel(value: unknown): BrowserAgentConsoleMessage["level"] {
  switch (value) {
    case "debug":
    case "error":
    case "info":
    case "warn":
      return value;
    default:
      return "log";
  }
}

export class BrowserAgentDiagnostics implements BrowserAgentDiagnosticsReader {
  private consoleBuffer: BrowserAgentConsoleMessage[] = [];
  private consoleChars = 0;
  private currentOrigin: string | null = null;
  private networkBuffer: BrowserAgentNetworkRequest[] = [];
  private readonly networkById = new Map<string, BrowserAgentNetworkRequest>();

  constructor(private readonly sendCommand: DebuggerCommand) {}

  committed(url: string): void {
    const nextOrigin = originOf(url);
    if (this.currentOrigin !== null && nextOrigin !== this.currentOrigin) {
      this.consoleBuffer = [];
      this.consoleChars = 0;
      this.networkBuffer = [];
      this.networkById.clear();
    }
    this.currentOrigin = nextOrigin;
  }

  handle(method: string, rawParams: unknown): void {
    const params = record(rawParams);
    if (!params) return;
    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(params.args) ? params.args : [];
      this.pushConsole({
        level: consoleLevel(params.type),
        origin: this.currentOrigin,
        text: args.map(textFromRemoteObject).join(" "),
        timestamp: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
      });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = record(params.exceptionDetails);
      const exception = record(details?.exception);
      this.pushConsole({
        level: "error",
        origin: this.currentOrigin,
        text: String(exception?.description ?? details?.text ?? "Uncaught exception"),
        timestamp: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
      });
      return;
    }
    if (method === "Log.entryAdded") {
      const entry = record(params.entry);
      if (!entry) return;
      this.pushConsole({
        level: consoleLevel(entry.level),
        origin: originOf(entry.url) ?? this.currentOrigin,
        text: String(entry.text ?? ""),
        timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
      });
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const requestId = typeof params.requestId === "string" ? params.requestId : null;
      const request = record(params.request);
      if (!requestId || !request || typeof request.url !== "string") return;
      const item: BrowserAgentNetworkRequest = {
        method: typeof request.method === "string" ? request.method : "GET",
        requestId,
        resourceType: typeof params.type === "string" ? params.type : undefined,
        timestamp: typeof params.wallTime === "number" ? params.wallTime * 1_000 : Date.now(),
        url: request.url,
      };
      this.pushNetwork(item);
      return;
    }
    if (method === "Network.responseReceived") {
      const requestId = typeof params.requestId === "string" ? params.requestId : null;
      const response = record(params.response);
      const item = requestId ? this.networkById.get(requestId) : undefined;
      if (!item || !response) return;
      if (typeof response.status === "number") item.status = response.status;
      if (typeof response.mimeType === "string") item.mimeType = response.mimeType;
      if (typeof params.type === "string") item.resourceType = params.type;
      return;
    }
    if (method === "Network.loadingFailed") {
      const requestId = typeof params.requestId === "string" ? params.requestId : null;
      const item = requestId ? this.networkById.get(requestId) : undefined;
      if (item) item.failed = String(params.errorText ?? "Request failed").slice(0, 1_000);
    }
  }

  consoleMessages(): readonly BrowserAgentConsoleMessage[] {
    return this.consoleBuffer;
  }

  networkRequests(): readonly BrowserAgentNetworkRequest[] {
    return this.networkBuffer;
  }

  async responseBody(requestId: string): Promise<{ base64Encoded: boolean; body: string }> {
    if (!this.networkById.has(requestId)) throw new Error("Network request id is unavailable or stale");
    const response = (await this.sendCommand("Network.getResponseBody", { requestId })) as {
      base64Encoded?: unknown;
      body?: unknown;
    };
    if (typeof response.body !== "string") throw new Error("Network response body is unavailable");
    const truncated = response.body.length > MAX_RESPONSE_BODY_CHARS;
    return {
      base64Encoded: response.base64Encoded === true,
      body: `${response.body.slice(0, MAX_RESPONSE_BODY_CHARS)}${truncated ? "\n[response body truncated]" : ""}`,
    };
  }

  private pushConsole(message: BrowserAgentConsoleMessage): void {
    const text = message.text.slice(0, MAX_CONSOLE_ENTRY_CHARS);
    if (!text) return;
    this.consoleBuffer.push({ ...message, text });
    this.consoleChars += text.length;
    while (
      this.consoleBuffer.length > MAX_CONSOLE_ENTRIES ||
      (this.consoleChars > MAX_CONSOLE_TOTAL_CHARS && this.consoleBuffer.length > 1)
    ) {
      const removed = this.consoleBuffer.shift();
      this.consoleChars -= removed?.text.length ?? 0;
    }
  }

  private pushNetwork(item: BrowserAgentNetworkRequest): void {
    const existing = this.networkById.get(item.requestId);
    if (existing) {
      Object.assign(existing, item);
      return;
    }
    this.networkBuffer.push(item);
    this.networkById.set(item.requestId, item);
    while (this.networkBuffer.length > MAX_NETWORK_ENTRIES) {
      const removed = this.networkBuffer.shift();
      if (removed) this.networkById.delete(removed.requestId);
    }
  }
}
