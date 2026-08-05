import { createServer, type Server } from "node:http";

import {
  DESKTOP_AUTH_CALLBACK_URL,
  DesktopAuthCallbackStore,
  type DesktopAuthCallbackStoreOptions,
  type PendingAuthCallback,
} from "./callback-store";

export interface DesktopAuthCallbackStatus {
  callbackUrl: string;
  listening: boolean;
  error: string | null;
}

export class DesktopAuthCallbackServer {
  private server: Server | undefined;
  private error: string | null = null;
  private readonly listeners = new Set<() => void>();
  readonly store: DesktopAuthCallbackStore;

  constructor(options: DesktopAuthCallbackStoreOptions = {}) {
    this.store = new DesktopAuthCallbackStore(options);
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = createServer((request, response) => this.handleRequest(request.url, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (cause: Error) => {
        server.removeListener("listening", onListening);
        this.server = undefined;
        this.error = cause.message;
        reject(cause);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        this.error = null;
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(17631, "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  beginAuthorization(url: string): void {
    this.store.beginAuthorization(url);
  }

  getStatus(): DesktopAuthCallbackStatus {
    return {
      callbackUrl: DESKTOP_AUTH_CALLBACK_URL,
      listening: Boolean(this.server),
      error: this.error,
    };
  }

  getPending(): PendingAuthCallback | null {
    return this.store.getPending();
  }

  complete(id: number): boolean {
    return this.store.complete(id);
  }

  onCallbackReady(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleRequest(rawUrl: string | undefined, response: import("node:http").ServerResponse): void {
    const requestUrl = new URL(rawUrl ?? "/", DESKTOP_AUTH_CALLBACK_URL);
    if (requestUrl.origin + requestUrl.pathname !== DESKTOP_AUTH_CALLBACK_URL) {
      response.writeHead(404).end();
      return;
    }

    try {
      this.store.acceptCallback(requestUrl.toString());
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end("<!doctype html><title>Ardor sign-in</title><p>You can return to Ardor.</p>");
      for (const listener of this.listeners) listener();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "auth callback rejected";
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(message);
    }
  }
}
