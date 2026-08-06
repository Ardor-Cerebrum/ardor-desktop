import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import {
  DESKTOP_AUTH_CALLBACK_URL,
  DesktopAuthCallbackStore,
  type DesktopAuthCallbackStoreOptions,
  type PendingAuthCallback,
} from "./callback-store";
import { renderAuthCallbackPage, renderAuthFocusPage } from "./callback-page";

const DESKTOP_AUTH_FOCUS_URL = "http://127.0.0.1:17631/auth/focus";
const DEFAULT_FOCUS_TOKEN_TTL_MS = 600_000;

interface FocusGrant {
  token: string;
  expiresAt: number;
}

export interface DesktopAuthCallbackServerOptions extends DesktopAuthCallbackStoreOptions {
  onFocus?: () => boolean | void;
  focusTokenTtlMs?: number;
}

export interface DesktopAuthCallbackStatus {
  callbackUrl: string;
  listening: boolean;
  error: string | null;
}

export class DesktopAuthCallbackServer {
  private server: Server | undefined;
  private error: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly onFocus: (() => boolean | void) | undefined;
  private readonly focusTokenTtlMs: number;
  private focusGrant: FocusGrant | undefined;
  readonly store: DesktopAuthCallbackStore;

  constructor(options: DesktopAuthCallbackServerOptions = {}) {
    this.store = new DesktopAuthCallbackStore(options);
    this.now = options.now ?? Date.now;
    this.onFocus = options.onFocus;
    this.focusTokenTtlMs = options.focusTokenTtlMs ?? options.ttlMs ?? DEFAULT_FOCUS_TOKEN_TTL_MS;
    if (!Number.isFinite(this.focusTokenTtlMs) || this.focusTokenTtlMs <= 0) {
      throw new RangeError("auth focus token TTL must be positive");
    }
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = createServer((request, response) => this.handleRequest(request.method, request.url, response));
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
    this.focusGrant = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  beginAuthorization(url: string): void {
    this.store.beginAuthorization(url);
    this.focusGrant = {
      token: randomUUID(),
      expiresAt: this.now() + this.focusTokenTtlMs,
    };
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

  private handleRequest(method: string | undefined, rawUrl: string | undefined, response: ServerResponse): void {
    const requestUrl = new URL(rawUrl ?? "/", DESKTOP_AUTH_CALLBACK_URL);
    const route = requestUrl.origin + requestUrl.pathname;
    if (method !== "GET") {
      this.writeHtml(response, 405, renderAuthCallbackPage(405, "This sign-in link only accepts a browser GET request."));
      return;
    }
    if (route === DESKTOP_AUTH_FOCUS_URL) {
      this.handleFocusRequest(requestUrl, response);
      return;
    }
    if (route !== DESKTOP_AUTH_CALLBACK_URL) {
      this.writeHtml(response, 404, renderAuthCallbackPage(404, "This sign-in link is no longer available."));
      return;
    }

    try {
      this.store.acceptCallback(requestUrl.toString());
      this.writeHtml(
        response,
        200,
        renderAuthCallbackPage(200, "Sign-in is continuing in Ardor Desktop.", this.activeFocusToken()),
      );
      for (const listener of this.listeners) listener();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "auth callback rejected";
      this.writeHtml(response, 400, renderAuthCallbackPage(400, message));
    }
  }

  private handleFocusRequest(requestUrl: URL, response: ServerResponse): void {
    const tokens = requestUrl.searchParams.getAll("token");
    const token = tokens.length === 1 ? tokens[0] : undefined;
    const grant = this.focusGrant;
    if (!token || !grant || grant.expiresAt <= this.now() || token !== grant.token) {
      this.writeHtml(response, 404, renderAuthCallbackPage(404, "This sign-in handoff is no longer available."));
      return;
    }

    this.focusGrant = undefined;
    try {
      const focused = this.onFocus?.();
      if (focused === false) {
        throw new Error("desktop window is unavailable");
      }
      this.writeHtml(response, 200, renderAuthFocusPage(), {
        "content-security-policy":
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'; script-src 'sha256-9BF3h95D4gf41+ZlhLfMEOev9mzuvZZJXQQv85BUx9k='",
      });
    } catch {
      this.writeHtml(
        response,
        500,
        renderAuthCallbackPage(500, "Ardor is open, but its window could not be focused. Select Ardor from the taskbar to continue."),
      );
    }
  }

  private activeFocusToken(): string | undefined {
    if (!this.focusGrant) {
      return undefined;
    }
    if (this.focusGrant.expiresAt <= this.now()) {
      this.focusGrant = undefined;
      return undefined;
    }
    return this.focusGrant.token;
  }

  private writeHtml(
    response: ServerResponse,
    status: number,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    response
      .writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'",
        ...extraHeaders,
      })
      .end(body);
  }
}
