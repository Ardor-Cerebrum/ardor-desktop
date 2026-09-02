import type { DesktopAuthUser, DesktopMintedToken, IdentityBffClientContract } from "./bff-client";
import type { DesktopAuthStartState, DesktopAuthStatus } from "../bridge-contract.js";

export interface DesktopAuthToken {
  readonly internalToken: string;
  readonly expiresAt: number;
  readonly user: DesktopAuthUser;
}

interface SessionVaultContract {
  load(): string | null;
  save(sessionHandle: string): void;
  clear(): void;
}

interface CallbackContract {
  start(): Promise<unknown>;
  beginAuthorization(url: string): number;
  cancelAuthorization(id: number): boolean;
  takePending(): { id: number; grant: string } | null;
  complete(id: number): boolean;
}

export interface DesktopAuthSessionServiceOptions {
  callback: CallbackContract | null;
  client: IdentityBffClientContract;
  vault: SessionVaultContract;
  openExternal(url: string): Promise<unknown>;
  now?: () => number;
  onStatusChanged?: (status: DesktopAuthStatus) => void;
}

export class DesktopAuthSessionService {
  private readonly callback: CallbackContract | null;
  private readonly client: IdentityBffClientContract;
  private readonly vault: SessionVaultContract;
  private readonly openExternal: (url: string) => Promise<unknown>;
  private readonly now: () => number;
  private readonly onStatusChanged: ((status: DesktopAuthStatus) => void) | undefined;
  private status: DesktopAuthStatus = { state: "signed-out", recoverable: true };
  private pendingAppState: DesktopAuthStartState | undefined;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(options: DesktopAuthSessionServiceOptions) {
    this.callback = options.callback;
    this.client = options.client;
    this.vault = options.vault;
    this.openExternal = options.openExternal;
    this.now = options.now ?? Date.now;
    this.onStatusChanged = options.onStatusChanged;
  }

  getStatus(): DesktopAuthStatus {
    return this.status;
  }

  initialize(): DesktopAuthStatus {
    try {
      this.setStatus(this.vault.load() ? { state: "authenticated", recoverable: true } : { state: "signed-out", recoverable: true });
    } catch {
      this.setStatus({ state: "error", recoverable: true, reason: "encryption-unavailable" });
    }
    return this.status;
  }

  start(appState?: DesktopAuthStartState): Promise<DesktopAuthStatus> {
    return this.exclusive(async () => {
      this.pendingAppState = undefined;
      if (!this.callback) throw new Error("desktop authentication is unavailable");
      try {
        this.vault.load();
      } catch {
        this.setStatus({ state: "error", recoverable: true, reason: "encryption-unavailable" });
        throw new Error("desktop authentication is unavailable");
      }
      let started: Awaited<ReturnType<IdentityBffClientContract["start"]>>;
      try {
        await this.callback.start();
        started = await this.client.start("http://127.0.0.1:17631/auth/callback");
      } catch {
        this.pendingAppState = undefined;
        this.setStatus({ state: "error", recoverable: true, reason: "network" });
        throw new Error("desktop authentication is unavailable");
      }
      const authorizationId = this.callback.beginAuthorization(started.authorizationUrl);
      this.pendingAppState = copyAppState(appState);
      try {
        await this.openExternal(started.authorizationUrl);
      } catch {
        this.callback.cancelAuthorization(authorizationId);
        this.pendingAppState = undefined;
        this.setStatus({ state: "error", recoverable: true, reason: "network" });
        throw new Error("desktop authentication is unavailable");
      }
      this.setStatus({ state: "authorizing", recoverable: true });
      return this.status;
    });
  }

  completeCallback(): Promise<DesktopAuthStatus> {
    return this.exclusive(async () => {
      const pending = this.callback?.takePending();
      if (!pending) throw new Error("desktop authentication is unavailable");
      let previousHandle: string | null;
      try {
        previousHandle = this.vault.load();
      } catch {
        this.setStatus({ state: "error", recoverable: true, reason: "encryption-unavailable" });
        throw new Error("desktop authentication is unavailable");
      }
      let redeemed: Awaited<ReturnType<IdentityBffClientContract["redeem"]>>;
      try {
        redeemed = await this.client.redeem(pending.grant, previousHandle);
      } catch {
        this.pendingAppState = undefined;
        this.vault.clear();
        this.setStatus({ state: "error", recoverable: true, reason: "network" });
        throw new Error("desktop authentication is unavailable");
      }
      try {
        this.vault.save(redeemed.sessionHandle);
      } catch {
        this.pendingAppState = undefined;
        await this.bestEffortRevoke(redeemed.sessionHandle);
        this.vault.clear();
        this.setStatus({ state: "error", recoverable: true, reason: "encryption-unavailable" });
        throw new Error("desktop authentication is unavailable");
      }
      if (!this.callback?.complete(pending.id)) {
        this.pendingAppState = undefined;
        await this.bestEffortRevoke(redeemed.sessionHandle);
        this.vault.clear();
        this.setStatus({ state: "error", recoverable: true, reason: "network" });
        throw new Error("desktop authentication is unavailable");
      }
      const appState = this.pendingAppState;
      this.pendingAppState = undefined;
      this.setStatus({
        state: "authenticated",
        recoverable: true,
        ...(appState === undefined ? {} : { appState }),
      });
      return this.status;
    });
  }

  getToken(): Promise<DesktopAuthToken> {
    return this.exclusive(async () => {
      let handle: string | null;
      try {
        handle = this.vault.load();
      } catch {
        this.setStatus({ state: "error", recoverable: true, reason: "encryption-unavailable" });
        throw new Error("desktop authentication is unavailable");
      }
      if (!handle) {
        this.setStatus({ state: "signed-out", recoverable: true, reason: "authentication-required" });
        throw new Error("desktop authentication is required");
      }
      let minted: DesktopMintedToken;
      try {
        minted = await this.client.mint(handle);
      } catch {
        this.vault.clear();
        this.setStatus({ state: "error", recoverable: true, reason: "network" });
        throw new Error("desktop authentication is unavailable");
      }
      await this.persistMintedHandle(minted);
      return {
        internalToken: minted.internalToken,
        expiresAt: this.now() + minted.expiresIn * 1000,
        user: minted.user,
      };
    });
  }

  logout(): Promise<DesktopAuthStatus> {
    return this.revoke(false);
  }

  logoutAll(): Promise<DesktopAuthStatus> {
    return this.revoke(true);
  }

  private revoke(all: boolean): Promise<DesktopAuthStatus> {
    return this.exclusive(async () => {
      this.pendingAppState = undefined;
      let handle: string | null;
      try {
        handle = this.vault.load();
      } catch {
        this.setStatus({ state: "error", recoverable: true, reason: "encryption-unavailable" });
        throw new Error("desktop authentication is unavailable");
      }
      let revocationFailed = false;
      if (handle) {
        try {
          if (all) await this.client.logoutAll(handle);
          else await this.client.logout(handle);
        } catch {
          revocationFailed = true;
        }
      }
      try {
        this.vault.clear();
      } catch {
        this.setStatus({ state: "error", recoverable: true, reason: "encryption-unavailable" });
        throw new Error("desktop authentication is unavailable");
      }
      this.setStatus({ state: "signed-out", recoverable: true });
      if (revocationFailed) {
        throw new Error("desktop authentication is unavailable");
      }
      return this.status;
    });
  }

  private async persistMintedHandle(minted: DesktopMintedToken): Promise<void> {
    try {
      this.vault.save(minted.replacementSessionHandle);
    } catch {
      await this.bestEffortRevoke(minted.replacementSessionHandle);
      this.vault.clear();
      this.setStatus({ state: "error", recoverable: true, reason: "encryption-unavailable" });
      throw new Error("desktop authentication is unavailable");
    }
  }

  private async bestEffortRevoke(sessionHandle: string): Promise<void> {
    try {
      await this.client.logout(sessionHandle);
    } catch {
      // The local vault remains fail-closed; no credential is returned to the renderer.
    }
  }

  private setStatus(status: DesktopAuthStatus): void {
    this.status = Object.freeze(status);
    try {
      this.onStatusChanged?.(this.status);
    } catch {
      // Renderer notification lifecycle must not alter privileged auth state.
    }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.operation.then(work, work);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

function copyAppState(appState: DesktopAuthStartState | undefined): DesktopAuthStartState | undefined {
  if (!appState) return undefined;
  return Object.freeze({
    ...(appState.returnTo === undefined ? {} : { returnTo: appState.returnTo }),
    ...(appState.userCopilotInput === undefined ? {} : { userCopilotInput: appState.userCopilotInput }),
  });
}
