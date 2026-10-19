import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { LocalAgentRuntimeScope } from "./protocol.js";

const RELAY_HOST = "127.0.0.1";
const RELAY_PATH = "/v1/responses";
const UPSTREAM_PATH = "/haron-api/api/cerebrum/desktop/responses";
const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
const MAX_THREAD_ID_LENGTH = 256;

export interface LocalResponsesRelayOptions {
  readonly apiOrigin: string;
  readonly runtimeId: string;
  readonly generation: number;
  readonly relayToken?: string;
  readonly scope: LocalAgentRuntimeScope;
  readonly getAccessToken: (forceRefresh: boolean) => Promise<string>;
  readonly onAuthStateChange?: (state: "ready" | "needs-auth") => void;
  readonly fetch?: typeof fetch;
  readonly maxRequestBytes?: number;
}

export class LocalResponsesRelay {
  private readonly apiOrigin: string;
  private readonly fetcher: typeof fetch;
  private readonly getAccessToken: LocalResponsesRelayOptions["getAccessToken"];
  private readonly maxRequestBytes: number;
  private readonly onAuthStateChange: LocalResponsesRelayOptions["onAuthStateChange"];
  private readonly relayToken: string;
  private readonly scope: LocalAgentRuntimeScope;
  private readonly server: Server;
  private readonly tokenDigest: Buffer;
  private startPromise: Promise<number> | null = null;

  constructor(options: LocalResponsesRelayOptions) {
    this.apiOrigin = validateApiOrigin(options.apiOrigin);
    this.fetcher = options.fetch ?? fetch;
    this.getAccessToken = options.getAccessToken;
    this.scope = options.scope;
    this.maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
    this.onAuthStateChange = options.onAuthStateChange;
    this.relayToken = options.relayToken ?? randomBytes(32).toString("base64url");
    this.tokenDigest = createHash("sha256").update(this.relayToken).digest();
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
  }

  get port(): number | null {
    const address = this.server.address();
    return address && typeof address === "object" ? address.port : null;
  }

  get token(): string {
    return this.relayToken;
  }

  start(): Promise<number> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<number>((resolvePort, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const port = this.port;
        if (port === null) {
          reject(new Error("Local model relay did not bind to a port."));
          return;
        }
        resolvePort(port);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, RELAY_HOST);
    });
    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolveClose) => {
      this.server.close(() => resolveClose());
      this.server.closeAllConnections();
    });
    this.startPromise = null;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      writeError(response, 403, "Loopback access is required.");
      return;
    }
    if (request.method !== "POST" || request.url !== RELAY_PATH) {
      writeError(response, 404, "Model relay route not found.");
      return;
    }
    if (!this.hasValidBearer(request.headers.authorization)) {
      writeError(response, 401, "Model relay authorization failed.");
      return;
    }
    const threadId = readSingleHeader(request.headers["thread-id"]);
    if (!threadId || threadId.length > MAX_THREAD_ID_LENGTH || /[\r\n\0]/.test(threadId)) {
      writeError(response, 400, "Thread identity is required.");
      return;
    }

    let body: Buffer;
    try {
      body = await readRequestBody(request, this.maxRequestBytes);
    } catch (cause) {
      if (response.writableEnded || response.destroyed) return;
      const status = cause instanceof RequestBodyTooLargeError ? 413 : 400;
      writeError(response, status, cause instanceof Error ? cause.message : "Request body is invalid.");
      return;
    }

    const abortController = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) abortController.abort();
    });
    try {
      let token: string;
      try {
        token = await this.getAccessToken(false);
      } catch (cause) {
        this.onAuthStateChange?.("needs-auth");
        throw cause;
      }
      let upstream = await this.forward(body, threadId, token, abortController.signal);
      if (upstream.status === 401 && !abortController.signal.aborted) {
        await upstream.body?.cancel();
        try {
          token = await this.getAccessToken(true);
        } catch (cause) {
          this.onAuthStateChange?.("needs-auth");
          throw cause;
        }
        upstream = await this.forward(body, threadId, token, abortController.signal);
      }
      this.onAuthStateChange?.(upstream.status === 401 ? "needs-auth" : "ready");
      await streamResponse(upstream, response, abortController.signal);
    } catch (cause) {
      if (response.writableEnded || response.destroyed || abortController.signal.aborted) return;
      writeError(response, 502, cause instanceof Error ? cause.message : "Model gateway is unavailable.");
    }
  }

  private async forward(
    body: Buffer,
    threadId: string,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Response> {
    if (!isSafeAccessToken(accessToken)) {
      throw new Error("Ardor sign-in is required for local model requests.");
    }
    const headers = new Headers({
      accept: "text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "thread-id": threadId,
      "x-ardor-workspace-id": this.scope.workspaceId,
    });
    return this.fetcher(new URL(UPSTREAM_PATH, this.apiOrigin), {
      method: "POST",
      headers,
      body: body.toString("utf8"),
      signal,
      redirect: "error",
    });
  }

  private hasValidBearer(value: string | string[] | undefined): boolean {
    if (typeof value !== "string") return false;
    const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(value);
    if (!match?.[1]) return false;
    const digest = createHash("sha256").update(match[1]).digest();
    return timingSafeEqual(digest, this.tokenDigest);
  }
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Responses request is too large.");
  }
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new RequestBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function streamResponse(upstream: Response, response: ServerResponse, signal: AbortSignal): Promise<void> {
  response.statusCode = upstream.status;
  for (const name of ["content-type", "cache-control", "retry-after", "x-ardor-error-code", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
  if (!upstream.body) {
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) break;
      if (!response.write(result.value)) {
        await waitForDrain(response, signal);
      }
    }
    if (!response.destroyed && !response.writableEnded) response.end();
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDrain) => {
    const cleanup = () => {
      response.off("drain", onReady);
      response.off("close", onReady);
      signal.removeEventListener("abort", onReady);
    };
    const onReady = () => {
      cleanup();
      resolveDrain();
    };
    response.once("drain", onReady);
    response.once("close", onReady);
    signal.addEventListener("abort", onReady, { once: true });
    if (signal.aborted || response.destroyed) onReady();
  });
}

function validateApiOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Desktop model gateway origin is invalid.");
  }
  return url.origin;
}

function readSingleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSafeAccessToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 16_384 && !/[\r\n\0]/.test(value);
}

function writeError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  const payload = JSON.stringify({ error: { message } });
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}
