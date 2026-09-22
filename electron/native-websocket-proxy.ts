import WebSocket, { WebSocketServer, type RawData } from "ws";

export const NATIVE_WEBSOCKET_PROXY_HOST = "127.0.0.1";
export const NATIVE_WEBSOCKET_PROXY_PORT = 17632;
export const NATIVE_WEBSOCKET_PROXY_PATH = "/cerebrum-native/app-server";

const STAGE_API_ORIGIN = "https://azure-stage.dev.ardor.cloud";
const PRODUCTION_API_ORIGIN = "https://console.ardor.cloud";
const STAGE_WEBSOCKET_ORIGIN = "wss://azure-stage.dev.ardor.cloud";
const PRODUCTION_WEBSOCKET_ORIGIN = "wss://console.ardor.cloud";
const NATIVE_QUERY_VALUE = /^[A-Za-z0-9_-]{1,256}$/;

export interface NativeWebSocketProxyOptions {
  apiOrigin: string;
  getCookieHeader: () => Promise<string>;
  allowedOrigin: string;
  webSocketOrigin?: string;
  host?: string;
  port?: number;
}

export class NativeWebSocketProxy {
  readonly #apiOrigin: string;
  readonly #getCookieHeader: () => Promise<string>;
  readonly #allowedOrigin: string;
  readonly #host: string;
  readonly #port: number;
  readonly #webSocketOrigin: string;
  readonly #server: WebSocketServer;
  #startPromise: Promise<void> | undefined;
  #isStarted = false;

  constructor(options: NativeWebSocketProxyOptions) {
    this.#apiOrigin = options.apiOrigin;
    this.#getCookieHeader = options.getCookieHeader;
    this.#allowedOrigin = options.allowedOrigin;
    this.#host = options.host ?? NATIVE_WEBSOCKET_PROXY_HOST;
    this.#port = options.port ?? NATIVE_WEBSOCKET_PROXY_PORT;
    this.#webSocketOrigin = options.webSocketOrigin ?? resolveNativeWebSocketOrigin(options.apiOrigin);
    this.#server = new WebSocketServer({
      host: this.#host,
      path: NATIVE_WEBSOCKET_PROXY_PATH,
      port: this.#port,
      verifyClient: ({ origin }: { origin: string }) => origin === this.#allowedOrigin,
    });
    this.#server.on("connection", (client, request) => {
      void this.#proxyConnection(client, request.url ?? NATIVE_WEBSOCKET_PROXY_PATH);
    });
  }

  get port(): number {
    const address = this.#server.address();
    return typeof address === "object" && address ? address.port : this.#port;
  }

  start(): Promise<void> {
    if (this.#startPromise) {
      return this.#startPromise;
    }

    this.#startPromise = new Promise<void>((resolve, reject) => {
      const handleListening = () => {
        this.#server.off("error", handleError);
        this.#isStarted = true;
        resolve();
      };
      const handleError = (error: Error) => {
        this.#server.off("listening", handleListening);
        reject(error);
      };
      this.#server.once("listening", handleListening);
      this.#server.once("error", handleError);
    });
    return this.#startPromise;
  }

  async stop(): Promise<void> {
    for (const client of this.#server.clients) {
      client.close(1001, "Desktop is shutting down");
    }
    if (!this.#isStarted) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
    this.#isStarted = false;
  }

  #remoteUrl(requestUrl: string): string {
    const query = new URL(requestUrl, "ws://127.0.0.1").searchParams;
    const upstream = new URL(`${this.#webSocketOrigin}${NATIVE_WEBSOCKET_PROXY_PATH}`);
    const safeQuery = new URLSearchParams();
    for (const key of ["thread", "workspace", "draft"]) {
      const value = query.get(key);
      if (value && NATIVE_QUERY_VALUE.test(value)) {
        safeQuery.set(key, value);
      }
    }
    if (query.get("mode") === "live") {
      safeQuery.set("mode", "live");
    }
    upstream.search = safeQuery.toString();
    return upstream.toString();
  }

  async #proxyConnection(client: WebSocket, requestUrl: string): Promise<void> {
    let cookieHeader: string;
    try {
      cookieHeader = await this.#getCookieHeader();
    } catch (error) {
      client.close(1011, "Could not read the desktop session");
      console.error("Native WebSocket proxy could not read session cookies", error);
      return;
    }

    const remote = new WebSocket(this.#remoteUrl(requestUrl), {
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        Origin: this.#apiOrigin,
      },
    });
    const pendingMessages: Array<{ data: RawData; isBinary: boolean }> = [];

    client.on("message", (data, isBinary) => {
      if (remote.readyState === WebSocket.OPEN) {
        remote.send(data, { binary: isBinary });
      } else if (remote.readyState === WebSocket.CONNECTING) {
        pendingMessages.push({ data, isBinary });
      }
    });
    client.on("close", (code, reason) => {
      pendingMessages.length = 0;
      if (remote.readyState === WebSocket.OPEN || remote.readyState === WebSocket.CONNECTING) {
        remote.close(code, reason);
      }
    });
    client.on("error", () => remote.terminate());

    remote.on("open", () => {
      for (const message of pendingMessages) {
        remote.send(message.data, { binary: message.isBinary });
      }
      pendingMessages.length = 0;
    });
    remote.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    remote.on("close", (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(code, reason);
      }
    });
    remote.on("error", (error) => {
      console.error("Native WebSocket proxy upstream failed", error.message);
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1011, "Native app-server connection failed");
      }
    });
    remote.on("unexpected-response", (_request, response) => {
      console.error(
        "Native WebSocket proxy upstream response",
        response.statusCode,
        response.headers["content-type"] ?? "",
      );
    });
  }
}

function resolveNativeWebSocketOrigin(apiOrigin: string): string {
  switch (apiOrigin) {
    case STAGE_API_ORIGIN:
      return STAGE_WEBSOCKET_ORIGIN;
    case PRODUCTION_API_ORIGIN:
      return PRODUCTION_WEBSOCKET_ORIGIN;
    default:
      throw new Error(`Unsupported native API origin for the desktop WebSocket relay: ${apiOrigin}`);
  }
}
