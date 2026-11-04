import { randomUUID } from "node:crypto";

import type { LocalAgentRuntimeScope } from "./protocol.js";

export interface LocalAgentTokenRequest extends LocalAgentRuntimeScope {
  readonly requestId: string;
  readonly runtimeId: string;
  readonly generation: number;
  readonly forceRefresh: boolean;
}

export interface LocalAgentTokenReply {
  readonly requestId: string;
  readonly runtimeId: string;
  readonly generation: number;
  readonly accessToken: string;
}

interface PendingToken {
  readonly reject: (error: Error) => void;
  readonly request: LocalAgentTokenRequest;
  readonly resolve: (token: string) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class LocalAgentTokenBroker {
  private readonly createRequestId: () => string;
  private readonly pending = new Map<string, PendingToken>();
  private readonly requestTimeoutMs: number;
  private readonly listeners = new Set<(request: LocalAgentTokenRequest) => void>();

  constructor(options: { requestTimeoutMs?: number; createRequestId?: () => string } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.createRequestId = options.createRequestId ?? randomUUID;
    if (this.requestTimeoutMs < 1) throw new RangeError("local auth request timeout must be positive");
  }

  requestToken(
    context: LocalAgentRuntimeScope & { readonly runtimeId: string; readonly generation: number },
    forceRefresh: boolean,
  ): Promise<string> {
    const requestId = this.createRequestId();
    const request: LocalAgentTokenRequest = { ...context, requestId, forceRefresh };
    return new Promise<string>((resolveToken, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Local auth request timed out."));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { reject, request, resolve: resolveToken, timer });
      for (const listener of [...this.listeners]) {
        try {
          listener(request);
        } catch {
          // A shell listener cannot disrupt model requests for another runtime.
        }
      }
    });
  }

  provideToken(reply: LocalAgentTokenReply): boolean {
    const pending = this.pending.get(reply.requestId);
    if (!pending || pending.request.runtimeId !== reply.runtimeId || pending.request.generation !== reply.generation ||
        !isLocalAgentAccessToken(reply.accessToken)) {
      return false;
    }
    this.pending.delete(reply.requestId);
    clearTimeout(pending.timer);
    pending.resolve(reply.accessToken);
    return true;
  }

  getPendingRequest(requestId: string): LocalAgentTokenRequest | null {
    const pending = this.pending.get(requestId);
    return pending ? { ...pending.request } : null;
  }

  rejectRequest(requestId: string, error: Error): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
    return true;
  }

  onRequest(listener: (request: LocalAgentTokenRequest) => void): () => void {
    this.listeners.add(listener);
    for (const pending of this.pending.values()) {
      try {
        listener(pending.request);
      } catch {
        // A shell listener cannot disrupt model requests for another runtime.
      }
    }
    return () => this.listeners.delete(listener);
  }

  getPendingRequests(accountId: string): LocalAgentTokenRequest[] {
    return [...this.pending.values()]
      .map((pending) => pending.request)
      .filter((request) => request.accountId === accountId);
  }

  cancelRuntime(runtimeId: string, generation: number): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.runtimeId !== runtimeId || pending.request.generation !== generation) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error("Local auth request was cancelled."));
    }
  }

  cancelAccount(accountId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.accountId !== accountId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error("Local auth request was cancelled."));
    }
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Local auth request was cancelled."));
    }
    this.pending.clear();
  }
}

export function isLocalAgentAccessToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 16_384 &&
    !/[\r\n\0]/.test(value);
}
