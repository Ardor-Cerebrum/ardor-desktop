import WebSocket, { WebSocketServer, type RawData } from "ws";

export const NATIVE_WEBSOCKET_PROXY_HOST = "127.0.0.1";
export const NATIVE_WEBSOCKET_PROXY_PORT = 17632;
export const NATIVE_WEBSOCKET_PROXY_PATH = "/cerebrum-native/app-server";

export interface NativeWebSocketProxyOptions {
  apiOrigin: string;
  getCookieHeader: () => Promise<string>;
  allowedOrigin: string;
  host?: string;
  port?: number;
}

export class NativeWebSocketProxy {
  readonly #apiOrigin: string;
  readonly #getCookieHeader: () => Promise<string>;
  readonly #allowedOrigin: string;
  readonly #host: string;
  readonly #port: number;
  readonly #server: WebSocketServer;
  #startPromise: Promise<void> | undefined;
  #isStarted = false;

  constructor(options: NativeWebSocketProxyOptions) {
    this.#apiOrigin = options.apiOrigin;
    this.#getCookieHeader = options.getCookieHeader;
    this.#allowedOrigin = options.allowedOrigin;
    this.#host = options.host ?? NATIVE_WEBSOCKET_PROXY_HOST;
    this.#port = options.port ?? NATIVE_WEBSOCKET_PROXY_PORT;
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
    const api = new URL(this.#apiOrigin);
    api.protocol = api.protocol === "https:" ? "wss:" : "ws:";
    // The server is mounted at one fixed path. Only carry the client's query
    // string across; never let a client-controlled URL replace the upstream
    // origin or path.
    api.pathname = NATIVE_WEBSOCKET_PROXY_PATH;
    const queryStart = requestUrl.indexOf("?");
    api.search = queryStart === -1 ? "" : requestUrl.slice(queryStart);
    return api.toString();
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
