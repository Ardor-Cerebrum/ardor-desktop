import { describe, expect, it } from "bun:test";
import WebSocket, { WebSocketServer } from "ws";
import { NativeWebSocketProxy } from "./native-websocket-proxy.js";

describe("NativeWebSocketProxy", () => {
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
});
