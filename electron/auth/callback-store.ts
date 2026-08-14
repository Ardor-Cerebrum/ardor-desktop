export const DESKTOP_AUTH_CALLBACK_URL = "http://127.0.0.1:17631/auth/callback";
const DEFAULT_TTL_MS = 600_000;

export interface PendingAuthCallback {
  id: number;
  callbackUrl: string;
}

export interface DesktopAuthCallbackStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

export class DesktopAuthCallbackStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private authorization: { state: string; expiresAt: number } | undefined;
  private pending: (PendingAuthCallback & { expiresAt: number }) | undefined;
  private nextId = 1;

  constructor(options: DesktopAuthCallbackStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("auth callback TTL must be positive");
    }
  }

  beginAuthorization(authorizationUrl: string): void {
    let url: URL;
    try {
      url = new URL(authorizationUrl);
    } catch {
      throw new Error("auth authorization URL is invalid");
    }
    const state = url.searchParams.get("state");
    if (!state) {
      throw new Error("auth authorization URL has no state");
    }
    this.authorization = {
      state,
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending = undefined;
  }

  cancelAuthorization(): void {
    this.authorization = undefined;
    this.pending = undefined;
  }

  acceptCallback(callbackUrl: string): PendingAuthCallback {
    const url = new URL(callbackUrl);
    if (url.origin + url.pathname !== DESKTOP_AUTH_CALLBACK_URL) {
      throw new Error("auth callback URL is invalid");
    }
    const state = url.searchParams.get("state");
    const authorization = this.authorization;
    if (authorization && authorization.expiresAt <= this.now()) {
      this.authorization = undefined;
      throw new Error("auth authorization state expired");
    }
    if (!state || !authorization || state !== authorization.state) {
      throw new Error("auth callback state mismatch");
    }
    this.authorization = undefined;
    const pending: PendingAuthCallback & { expiresAt: number } = {
      id: this.nextId++,
      callbackUrl: url.toString(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending = pending;
    return { id: pending.id, callbackUrl: pending.callbackUrl };
  }

  getPending(): PendingAuthCallback | null {
    if (!this.pending) {
      return null;
    }
    if (this.pending.expiresAt <= this.now()) {
      this.pending = undefined;
      return null;
    }
    return { id: this.pending.id, callbackUrl: this.pending.callbackUrl };
  }

  complete(id: number): boolean {
    const pending = this.getPending();
    if (!pending || pending.id !== id) {
      return false;
    }
    this.pending = undefined;
    return true;
  }
}
