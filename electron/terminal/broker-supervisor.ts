import { randomUUID } from "node:crypto";

import {
  isTerminalBrokerMessage,
  isTerminalBrokerRequest,
  TERMINAL_BROKER_PROTOCOL_VERSION,
  type TerminalBrokerRequest,
  type TerminalEventMessage,
  type TerminalResponseMessage,
} from "./protocol.js";

export interface TerminalBrokerChild {
  kill(): boolean;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "message", listener: (message: unknown) => void): this;
  postMessage(message: unknown): void;
  removeListener(event: "exit", listener: (code: number) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
}

interface TerminalSupervisorScheduler {
  clearTimeout(handle: unknown): void;
  setTimeout(callback: () => void, delay: number): unknown;
}

export interface TerminalBrokerSupervisorOptions {
  readonly createBrokerId?: () => string;
  readonly requestTimeoutMs?: number;
  readonly scheduler?: TerminalSupervisorScheduler;
  readonly spawn: (brokerId: string) => TerminalBrokerChild;
  readonly startTimeoutMs?: number;
}

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly requestType: TerminalBrokerRequest["type"];
  readonly resolve: (response: TerminalResponseMessage) => void;
  readonly timer: unknown;
}

const defaultScheduler: TerminalSupervisorScheduler = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
};

export class TerminalBrokerUnavailableError extends Error {
  constructor() {
    super("Terminal service is unavailable.");
    this.name = "TerminalBrokerUnavailableError";
  }
}

export class TerminalBrokerSupervisor {
  private brokerId: string | null = null;
  private child: TerminalBrokerChild | null = null;
  private disposed = false;
  private readonly eventListeners = new Set<(message: TerminalEventMessage) => void>();
  private readonly createBrokerId: () => string;
  private exitListener: ((code: number) => void) | null = null;
  private messageListener: ((message: unknown) => void) | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private ready = false;
  private readyReject: ((error: Error) => void) | null = null;
  private readyResolve: ((brokerId: string) => void) | null = null;
  private readyTimer: unknown | null = null;
  private readonly requestTimeoutMs: number;
  private readonly scheduler: TerminalSupervisorScheduler;
  private readonly spawn: (brokerId: string) => TerminalBrokerChild;
  private startPromise: Promise<string> | null = null;
  private readonly startTimeoutMs: number;
  private stopping = false;
  private readonly unavailableListeners = new Set<(brokerId: string) => void>();

  constructor(options: TerminalBrokerSupervisorOptions) {
    this.createBrokerId = options.createBrokerId ?? randomUUID;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.spawn = options.spawn;
    this.startTimeoutMs = options.startTimeoutMs ?? 5_000;
    if (this.requestTimeoutMs < 1 || this.startTimeoutMs < 1) {
      throw new RangeError("terminal broker timeouts must be positive");
    }
  }

  ensureReady(): Promise<string> {
    if (this.disposed) return Promise.reject(new TerminalBrokerUnavailableError());
    if (this.ready && this.brokerId) return Promise.resolve(this.brokerId);
    if (this.startPromise) return this.startPromise;

    const brokerId = this.createBrokerId();
    if (!brokerId) return Promise.reject(new TerminalBrokerUnavailableError());
    let child: TerminalBrokerChild;
    try {
      child = this.spawn(brokerId);
    } catch {
      return Promise.reject(new TerminalBrokerUnavailableError());
    }

    this.brokerId = brokerId;
    this.child = child;
    this.ready = false;
    this.messageListener = (message) => this.handleMessage(child, brokerId, message);
    this.exitListener = () => this.handleExit(child, brokerId);
    child.on("message", this.messageListener);
    child.on("exit", this.exitListener);

    this.startPromise = new Promise<string>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = this.scheduler.setTimeout(() => {
        if (this.child !== child || this.ready) return;
        this.failChild(child, brokerId, true);
      }, this.startTimeoutMs);
    });
    return this.startPromise;
  }

  request(request: TerminalBrokerRequest): Promise<TerminalResponseMessage> {
    if (!isTerminalBrokerRequest(request)) {
      return Promise.reject(new TypeError("terminal broker request is invalid"));
    }
    if (!this.ready || !this.child || !this.brokerId) {
      return this.ensureReady().then((brokerId) => {
        if (request.brokerId !== brokerId) throw new TerminalBrokerUnavailableError();
        return this.request(request);
      });
    }
    if (request.brokerId !== this.brokerId || this.pending.has(request.requestId)) {
      return Promise.reject(new TerminalBrokerUnavailableError());
    }

    const child = this.child;
    return new Promise<TerminalResponseMessage>((resolve, reject) => {
      const timer = this.scheduler.setTimeout(() => {
        const pending = this.pending.get(request.requestId);
        if (!pending || this.child !== child) return;
        this.failChild(child, request.brokerId, true);
      }, this.requestTimeoutMs);
      this.pending.set(request.requestId, {
        reject,
        requestType: request.type,
        resolve,
        timer,
      });
      try {
        child.postMessage(request);
      } catch {
        if (this.child === child) {
          this.failChild(child, request.brokerId, true);
          return;
        }
        this.scheduler.clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(new TerminalBrokerUnavailableError());
      }
    });
  }

  onEvent(listener: (message: TerminalEventMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onUnavailable(listener: (brokerId: string) => void): () => void {
    this.unavailableListeners.add(listener);
    return () => this.unavailableListeners.delete(listener);
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.stopping = true;
    const child = this.child;
    const brokerId = this.brokerId;
    if (child && brokerId && this.ready) {
      try {
        await this.request({
          brokerId,
          protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
          requestId: `shutdown:${randomUUID()}`,
          type: "shutdown",
        });
      } catch {
        // The child may exit immediately after processing the shutdown request.
      }
    }
    if (child && this.child === child) this.failChild(child, brokerId ?? "", true);
    this.disposed = true;
    this.stopping = false;
  }

  private handleMessage(child: TerminalBrokerChild, brokerId: string, message: unknown): void {
    if (this.child !== child || !isTerminalBrokerMessage(message) || message.brokerId !== brokerId) return;
    if (message.type === "ready") {
      if (this.ready) return;
      this.ready = true;
      if (this.readyTimer !== null) this.scheduler.clearTimeout(this.readyTimer);
      this.readyTimer = null;
      const resolve = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      this.startPromise = null;
      resolve?.(brokerId);
      return;
    }
    if (!this.ready) return;
    if (message.type === "event") {
      for (const listener of [...this.eventListeners]) listener(message);
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending || pending.requestType !== message.requestType) return;
    this.pending.delete(message.requestId);
    this.scheduler.clearTimeout(pending.timer);
    pending.resolve(message);
  }

  private handleExit(child: TerminalBrokerChild, brokerId: string): void {
    if (this.child !== child) return;
    this.failChild(child, brokerId, false);
  }

  private failChild(child: TerminalBrokerChild, brokerId: string, kill: boolean): void {
    if (this.child !== child) return;
    this.detachChild(child);
    if (kill) {
      try { child.kill(); } catch { /* The process may already have exited. */ }
    }
    this.child = null;
    this.brokerId = null;
    this.ready = false;
    if (this.readyTimer !== null) this.scheduler.clearTimeout(this.readyTimer);
    this.readyTimer = null;
    const unavailable = new TerminalBrokerUnavailableError();
    this.readyReject?.(unavailable);
    this.readyResolve = null;
    this.readyReject = null;
    this.startPromise = null;
    for (const pending of this.pending.values()) {
      this.scheduler.clearTimeout(pending.timer);
      pending.reject(unavailable);
    }
    this.pending.clear();
    if (!this.stopping) {
      for (const listener of [...this.unavailableListeners]) listener(brokerId);
    }
  }

  private detachChild(child: TerminalBrokerChild): void {
    if (this.messageListener) child.removeListener("message", this.messageListener);
    if (this.exitListener) child.removeListener("exit", this.exitListener);
    this.messageListener = null;
    this.exitListener = null;
  }
}
