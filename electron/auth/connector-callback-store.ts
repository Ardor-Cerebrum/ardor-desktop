import { timingSafeEqual } from "node:crypto";

import type { DesktopConnectorResult } from "../bridge-contract";

/** Where the browser returns after a connector sign-in, beside the Auth0 callback (RFC 8252 loopback return). */
export const DESKTOP_CONNECTOR_CALLBACK_URL = "http://127.0.0.1:17631/connector/callback";

const DEFAULT_TTL_MS = 600_000;
// NOTE: Must match what the backend accepts for `desktop_state`; it is the only value that comes back from the browser.
const STATE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface DesktopConnectorCallbackStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

/**
 * One pending connector sign-in at a time, like the Auth0 callback store: the renderer registers a one-time
 * `state` before the system browser opens, and only a browser return carrying that exact state is accepted, once.
 */
export class DesktopConnectorCallbackStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private pending: { state: string; expiresAt: number } | undefined;

  constructor(options: DesktopConnectorCallbackStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("connector callback TTL must be positive");
    }
  }

  begin(state: unknown): void {
    if (!isConnectorState(state)) {
      throw new Error("connector state is invalid");
    }
    this.pending = { state, expiresAt: this.now() + this.ttlMs };
  }

  cancel(state: string): void {
    if (this.pending?.state === state) {
      this.pending = undefined;
    }
  }

  accept(callbackUrl: string): DesktopConnectorResult {
    const url = new URL(callbackUrl);
    if (url.origin + url.pathname !== DESKTOP_CONNECTOR_CALLBACK_URL) {
      throw new Error("connector callback URL is invalid");
    }
    const state = singleParameter(url, "state");
    const provider = singleParameter(url, "connector");
    const status = singleParameter(url, "status");
    const pending = this.pending;
    if (pending && pending.expiresAt <= this.now()) {
      this.pending = undefined;
      throw new Error("connector sign-in expired");
    }
    if (!(pending && state && statesMatch(state, pending.state))) {
      throw new Error("connector callback state mismatch");
    }
    if (!(provider && PROVIDER_PATTERN.test(provider) && (status === "connected" || status === "error"))) {
      throw new Error("connector callback result is invalid");
    }
    this.pending = undefined;
    return { provider, status };
  }
}

export function isConnectorState(value: unknown): value is string {
  return typeof value === "string" && STATE_PATTERN.test(value);
}

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function statesMatch(received: string, expected: string): boolean {
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes);
}
