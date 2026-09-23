import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { getNativeWebSocketCookieHeader, NativeWebSocketProxy } from "./native-websocket-proxy.js";

describe("NativeWebSocketProxy", () => {
  it("reads path-scoped session cookies for the upstream WebSocket URL", async () => {
    let requestedUrl = "";
    const cookieHeader = await getNativeWebSocketCookieHeader("https://azure-stage.dev.ardor.cloud", {
      get: async ({ url }) => {
        requestedUrl = url;
        return new URL(url).pathname === "/cerebrum-native/app-server"
          ? [{ name: "__Secure-cerebrum-service", value: "test-session" }]
          : [];
      },
    });

    expect(requestedUrl).toBe("https://azure-stage.dev.ardor.cloud/cerebrum-native/app-server");
    expect(cookieHeader).toBe("__Secure-cerebrum-service=test-session");
  });

  it("forwards JSON-RPC frames with the API origin and session cookie", async () => {
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => upstream.once("listening", () => resolve()));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("The upstream test server did not expose a port");
    }

    const observed: { origin?: string; cookie?: string; url?: string } = {};
    upstream.on("connection", (socket, request) => {
      observed.origin = request.headers.origin;
      observed.cookie = request.headers.cookie;
      observed.url = request.url;
      socket.on("message", (message) => socket.send(message));
    });

    const proxy = new NativeWebSocketProxy({
      allowedOrigin: "ardor://app",
      apiOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      getCookieHeader: async () => "session=test-session",
      port: 0,
      webSocketOrigin: `ws://127.0.0.1:${upstreamAddress.port}`,
    });
    await proxy.start();

    const client = new WebSocket(
      `ws://127.0.0.1:${proxy.port}/cerebrum-native/app-server?thread=test&workspace=workspace-1&mode=live&draft=bad%2Fvalue`,
      {
      headers: { Origin: "ardor://app" },
      },
    );
    const reply = new Promise<string>((resolve, reject) => {
      client.once("message", (message) => resolve(message.toString()));
      client.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });
    client.send(JSON.stringify({ id: 1, method: "initialize" }));

    expect(await reply).toBe(JSON.stringify({ id: 1, method: "initialize" }));
    expect(observed).toEqual({
      origin: `http://127.0.0.1:${upstreamAddress.port}`,
      cookie: "session=test-session",
      url: "/cerebrum-native/app-server?thread=test&workspace=workspace-1&mode=live",
    });

    client.close();
    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("handles an abnormal local disconnect without throwing", async () => {
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => upstream.once("listening", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Upstream port unavailable");

    const upstreamClosed = new Promise<number>((resolve) => {
      upstream.once("connection", (socket) => {
        socket.once("close", (code) => resolve(code));
        socket.send("ready");
      });
    });
    const proxy = new NativeWebSocketProxy({
      allowedOrigin: "ardor://app",
      apiOrigin: `http://127.0.0.1:${address.port}`,
      getCookieHeader: async () => "session=test-session",
      port: 0,
      webSocketOrigin: `ws://127.0.0.1:${address.port}`,
    });
    await proxy.start();
    const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/cerebrum-native/app-server`, {
      headers: { Origin: "ardor://app" },
    });
    await new Promise<void>((resolve) => client.once("open", resolve));
    await new Promise<void>((resolve) => client.once("message", resolve));

    client.terminate();
    expect(await upstreamClosed).toBe(1006);

    await proxy.stop();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("closes the local client when the upstream rejects the WebSocket upgrade", async () => {
    const upstream = createServer();
    let upstreamSocket: import("node:net").Socket | undefined;
    upstream.on("upgrade", (_request, socket) => {
      upstreamSocket = socket;
      socket.write(
        "HTTP/1.1 502 Bad Gateway\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n",
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("The upstream test server did not expose a port");
    }

    const proxy = new NativeWebSocketProxy({
      allowedOrigin: "ardor://app",
      apiOrigin: `http://127.0.0.1:${upstreamAddress.port}`,
      getCookieHeader: async () => "session=test-session",
      port: 0,
      webSocketOrigin: `ws://127.0.0.1:${upstreamAddress.port}`,
    });
    let client: WebSocket | undefined;

    try {
      await proxy.start();
      client = new WebSocket(
        `ws://127.0.0.1:${proxy.port}/cerebrum-native/app-server`,
        { headers: { Origin: "ardor://app" } },
      );
      client.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        client?.once("open", resolve);
        client?.once("error", reject);
      });
      client.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));

      const closeResult = await new Promise<{ code: number; reason: string } | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 1000);
        client?.once("close", (code, reason) => {
          clearTimeout(timeout);
          resolve({ code, reason: reason.toString() });
        });
      });

      expect(closeResult).toEqual({
        code: 1011,
        reason: "Native app-server upstream rejected connection",
      });
    } finally {
      client?.terminate();
      upstreamSocket?.destroy();
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
