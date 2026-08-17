import {
  isWellFormedString,
  TERMINAL_BROKER_PROTOCOL_VERSION,
  TERMINAL_LIMITS,
  utf8ByteLength,
  type TerminalBrokerErrorCode,
  type TerminalBrokerRequest,
  type TerminalEvent,
  type TerminalEventMessage,
  type TerminalResponseMessage,
  type TerminalSnapshot,
} from "./protocol.js";
import type { PtyDisposable, PtyHost, PtyProcess, PtySpawnResult } from "./pty-host.js";
import { PtyHostError } from "./pty-host.js";
import { TerminalReplayBuffer } from "./replay-buffer.js";

interface TerminalScheduler {
  clearTimeout(handle: unknown): void;
  setTimeout(callback: () => void, delay: number): unknown;
}

export interface TerminalBrokerManagerOptions {
  readonly brokerId: string;
  readonly host: PtyHost;
  readonly onEvent: (message: TerminalEventMessage) => void;
  readonly scheduler?: TerminalScheduler;
}

interface DeliveryCredit {
  readonly bytes: number;
  readonly sequence: number;
}

interface TerminalSession {
  attached: boolean;
  closed: boolean;
  cols: number;
  commandSequence: number;
  cwd: string;
  dataDisposable: PtyDisposable | null;
  deliveryCredits: DeliveryCredit[];
  exitCode: number | null;
  exitDisposable: PtyDisposable | null;
  generation: number;
  ownerId: number;
  paused: boolean;
  pendingBytes: number;
  pendingChunks: string[];
  pendingTimer: unknown | null;
  pty: PtyProcess | null;
  readonly replay: TerminalReplayBuffer;
  rows: number;
  sequence: number;
  shell: string;
  terminalId: string;
  unacknowledgedBytes: number;
}

const PUBLIC_ERROR_MESSAGES: Readonly<Record<TerminalBrokerErrorCode, string>> = Object.freeze({
  BROKER_UNAVAILABLE: "Terminal service is unavailable.",
  INTERNAL: "Terminal operation failed.",
  INVALID_CWD: "Terminal working directory is invalid.",
  INVALID_REQUEST: "Terminal request is invalid.",
  NOT_FOUND: "Terminal session is unavailable.",
  OWNER_MISMATCH: "Terminal session belongs to another owner.",
  SESSION_LIMIT: "Terminal session limit reached.",
  SPAWN_FAILED: "Terminal process could not be started.",
  STALE_COMMAND: "Terminal command is stale.",
  STALE_GENERATION: "Terminal generation is stale.",
});

const SERVICE_LOST_REASON = "Terminal service became unavailable.";

class TerminalOperationError extends Error {
  constructor(readonly code: TerminalBrokerErrorCode) {
    super(PUBLIC_ERROR_MESSAGES[code]);
    this.name = "TerminalOperationError";
  }
}

const defaultScheduler: TerminalScheduler = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
};

export class TerminalBrokerManager {
  private readonly brokerId: string;
  private disposed = false;
  private readonly generationCounters = new Map<string, number>();
  private readonly host: PtyHost;
  private readonly onEvent: (message: TerminalEventMessage) => void;
  private readonly scheduler: TerminalScheduler;
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(options: TerminalBrokerManagerOptions) {
    if (!isWellFormedString(options.brokerId) || options.brokerId.length === 0) {
      throw new TypeError("brokerId must be a non-empty well-formed string");
    }
    this.brokerId = options.brokerId;
    this.host = options.host;
    this.onEvent = options.onEvent;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  handle(request: TerminalBrokerRequest): TerminalResponseMessage {
    if (request.brokerId !== this.brokerId || this.disposed) {
      return this.failure(request, "BROKER_UNAVAILABLE");
    }

    try {
      switch (request.type) {
        case "open":
          return this.success(request, this.open(request));
        case "detach": {
          const session = this.requireOrderedSession(request);
          this.flush(session);
          this.resetDeliveryCredit(session);
          session.attached = false;
          return this.success(request);
        }
        case "write": {
          const session = this.requireOrderedSession(request);
          const pty = this.requireRunningPty(session);
          try {
            pty.write(request.data);
          } catch {
            throw new TerminalOperationError("INTERNAL");
          }
          return this.success(request);
        }
        case "resize": {
          const session = this.requireOrderedSession(request);
          const pty = this.requireRunningPty(session);
          try {
            pty.resize(request.cols, request.rows);
          } catch {
            throw new TerminalOperationError("INTERNAL");
          }
          session.cols = request.cols;
          session.rows = request.rows;
          return this.success(request);
        }
        case "ack": {
          const session = this.requireOrderedSession(request);
          this.acknowledge(session, request.sequence);
          return this.success(request);
        }
        case "clear": {
          const session = this.requireOrderedSession(request);
          this.flush(session);
          session.replay.clear();
          return this.success(request);
        }
        case "restart": {
          const session = this.requireOrderedSession(request);
          return this.success(request, this.restart(session, request));
        }
        case "close": {
          const session = this.requireOrderedSession(request);
          this.closeSession(session, true);
          return this.success(request);
        }
        case "closeOwner":
          this.closeOwner(request.ownerId);
          return this.success(request);
        case "shutdown":
          this.dispose();
          return this.success(request);
      }
    } catch (error) {
      return this.failure(request, this.mapError(error));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    for (const session of [...this.sessions.values()]) this.closeSession(session, true);
    this.disposed = true;
  }

  private open(request: Extract<TerminalBrokerRequest, { type: "open" }>): TerminalSnapshot {
    const existing = this.sessions.get(request.terminalId);
    if (existing) {
      if (existing.ownerId !== request.ownerId) throw new TerminalOperationError("OWNER_MISMATCH");
      this.flush(existing);
      this.resetDeliveryCredit(existing);
      existing.attached = true;
      return this.snapshot(existing);
    }

    const ownerSessions = [...this.sessions.values()].filter((session) => session.ownerId === request.ownerId).length;
    if (
      ownerSessions >= TERMINAL_LIMITS.MAX_SESSIONS_PER_OWNER
      || this.sessions.size >= TERMINAL_LIMITS.MAX_SESSIONS_GLOBAL
    ) {
      throw new TerminalOperationError("SESSION_LIMIT");
    }

    const generationKey = this.generationKey(request.ownerId, request.terminalId);
    const generation = (this.generationCounters.get(generationKey) ?? 0) + 1;
    const spawned = this.spawn({ cols: request.cols, cwd: request.cwd, rows: request.rows });
    const session = this.createSession(request.ownerId, request.terminalId, generation, request.cols, request.rows, spawned);
    this.sessions.set(request.terminalId, session);
    try {
      this.bind(session, spawned.pty);
      this.flush(session);
    } catch {
      if (this.sessions.get(request.terminalId) === session) this.sessions.delete(request.terminalId);
      this.retireSession(session, true);
      throw new TerminalOperationError("INTERNAL");
    }
    this.generationCounters.set(generationKey, generation);
    return this.snapshot(session);
  }

  private restart(
    previous: TerminalSession,
    request: Extract<TerminalBrokerRequest, { type: "restart" }>,
  ): TerminalSnapshot {
    this.flush(previous);
    const cols = request.cols ?? previous.cols;
    const rows = request.rows ?? previous.rows;
    const spawned = this.spawn({ cols, cwd: request.cwd ?? previous.cwd, rows });
    const generation = previous.generation + 1;
    const replacement = this.createSession(
      previous.ownerId,
      previous.terminalId,
      generation,
      cols,
      rows,
      spawned,
    );

    this.sessions.set(previous.terminalId, replacement);
    try {
      this.bind(replacement, spawned.pty);
      this.flush(replacement);
    } catch {
      this.sessions.set(previous.terminalId, previous);
      this.retireSession(replacement, true);
      throw new TerminalOperationError("INTERNAL");
    }

    this.generationCounters.set(this.generationKey(previous.ownerId, previous.terminalId), generation);
    this.retireSession(previous, true);
    return this.snapshot(replacement);
  }

  private spawn(request: { cols: number; cwd?: string; rows: number }): PtySpawnResult {
    try {
      return this.host.spawn(request);
    } catch (error) {
      if (error instanceof PtyHostError) throw new TerminalOperationError(error.code);
      throw new TerminalOperationError("INTERNAL");
    }
  }

  private createSession(
    ownerId: number,
    terminalId: string,
    generation: number,
    cols: number,
    rows: number,
    spawned: PtySpawnResult,
  ): TerminalSession {
    return {
      attached: true,
      closed: false,
      cols,
      commandSequence: 0,
      cwd: spawned.cwd,
      dataDisposable: null,
      deliveryCredits: [],
      exitCode: null,
      exitDisposable: null,
      generation,
      ownerId,
      paused: false,
      pendingBytes: 0,
      pendingChunks: [],
      pendingTimer: null,
      pty: spawned.pty,
      replay: new TerminalReplayBuffer(),
      rows,
      sequence: 0,
      shell: spawned.shell,
      terminalId,
      unacknowledgedBytes: 0,
    };
  }

  private bind(session: TerminalSession, pty: PtyProcess): void {
    const dataDisposable = pty.onData((data) => this.handleData(session, pty, data));
    if (session.pty === pty && !session.closed) session.dataDisposable = dataDisposable;
    else dataDisposable.dispose();

    const exitDisposable = pty.onExit((event) => this.handleExit(session, pty, event.exitCode));
    if (session.pty === pty && !session.closed) session.exitDisposable = exitDisposable;
    else exitDisposable.dispose();
  }

  private handleData(session: TerminalSession, pty: PtyProcess, data: string): void {
    if (!this.isCurrent(session, pty) || data.length === 0) return;
    if (!isWellFormedString(data)) {
      this.failSession(session, pty);
      return;
    }

    let segment: string[] = [];
    let segmentBytes = 0;
    const commitSegment = () => {
      if (segment.length === 0) return;
      session.pendingChunks.push(segment.join(""));
      session.pendingBytes += segmentBytes;
      segment = [];
      segmentBytes = 0;
    };

    for (const codePoint of data) {
      const codePointBytes = utf8ByteLength(codePoint);
      if (session.pendingBytes + segmentBytes + codePointBytes > TERMINAL_LIMITS.OUTPUT_BATCH_BYTES) {
        commitSegment();
        this.flush(session);
        if (!this.isCurrent(session, pty)) return;
      }
      segment.push(codePoint);
      segmentBytes += codePointBytes;
      if (session.pendingBytes + segmentBytes === TERMINAL_LIMITS.OUTPUT_BATCH_BYTES) {
        commitSegment();
        this.flush(session);
        if (!this.isCurrent(session, pty)) return;
      }
    }
    commitSegment();

    if (session.pendingBytes > 0 && session.pendingTimer === null) {
      session.pendingTimer = this.scheduler.setTimeout(
        () => this.flush(session),
        TERMINAL_LIMITS.OUTPUT_BATCH_MS,
      );
    }
  }

  private handleExit(session: TerminalSession, pty: PtyProcess, exitCode: number): void {
    if (!this.isCurrent(session, pty)) return;
    this.flush(session);
    session.pty = null;
    session.exitCode = Number.isSafeInteger(exitCode) ? exitCode : null;
    session.paused = false;
    session.deliveryCredits = [];
    session.unacknowledgedBytes = 0;
    this.disposeSubscriptions(session);
    session.sequence += 1;
    if (session.attached) {
      this.emit({
        exitCode: session.exitCode,
        generation: session.generation,
        ownerId: session.ownerId,
        sequence: session.sequence,
        terminalId: session.terminalId,
        type: "exit",
      });
    }
  }

  private failSession(session: TerminalSession, pty: PtyProcess): void {
    if (!this.isCurrent(session, pty)) return;
    this.flush(session);
    session.pty = null;
    session.exitCode = null;
    session.paused = false;
    session.deliveryCredits = [];
    session.unacknowledgedBytes = 0;
    this.disposeSubscriptions(session);
    try { pty.kill(); } catch { /* The process may already be unavailable. */ }
    session.sequence += 1;
    if (session.attached) {
      this.emit({
        generation: session.generation,
        ownerId: session.ownerId,
        reason: SERVICE_LOST_REASON,
        sequence: session.sequence,
        terminalId: session.terminalId,
        type: "service-lost",
      });
    }
  }

  private flush(session: TerminalSession): void {
    if (session.pendingTimer !== null) {
      this.scheduler.clearTimeout(session.pendingTimer);
      session.pendingTimer = null;
    }
    if (session.closed || this.sessions.get(session.terminalId) !== session || session.pendingBytes === 0) return;

    const data = session.pendingChunks.join("");
    const bytes = session.pendingBytes;
    session.pendingChunks = [];
    session.pendingBytes = 0;
    session.sequence += 1;
    session.replay.append(session.sequence, data);
    if (!session.attached) return;

    const delivered = this.emit({
      data,
      generation: session.generation,
      ownerId: session.ownerId,
      sequence: session.sequence,
      terminalId: session.terminalId,
      type: "data",
    });
    if (!delivered) {
      session.attached = false;
      this.resetDeliveryCreditAfterDeliveryFailure(session);
      return;
    }

    session.deliveryCredits.push({ bytes, sequence: session.sequence });
    session.unacknowledgedBytes += bytes;
    if (
      !session.paused
      && session.pty
      && session.unacknowledgedBytes >= TERMINAL_LIMITS.PAUSE_HIGH_WATER_BYTES
    ) {
      try {
        session.pty.pause();
        session.paused = true;
      } catch {
        const pty = session.pty;
        if (pty) this.failSession(session, pty);
      }
    }
  }

  private acknowledge(session: TerminalSession, sequence: number): void {
    if (sequence > session.sequence) throw new TerminalOperationError("INVALID_REQUEST");
    let removedBytes = 0;
    session.deliveryCredits = session.deliveryCredits.filter((credit) => {
      if (credit.sequence <= sequence) {
        removedBytes += credit.bytes;
        return false;
      }
      return true;
    });
    session.unacknowledgedBytes -= removedBytes;
    if (
      session.paused
      && session.unacknowledgedBytes <= TERMINAL_LIMITS.RESUME_LOW_WATER_BYTES
    ) {
      this.resume(session);
    }
  }

  private resetDeliveryCredit(session: TerminalSession): void {
    if (session.paused) this.resume(session);
    session.deliveryCredits = [];
    session.unacknowledgedBytes = 0;
  }

  private resetDeliveryCreditAfterDeliveryFailure(session: TerminalSession): void {
    if (session.paused && session.pty) {
      try { session.pty.resume(); } catch { /* The renderer is already detached. */ }
    }
    session.paused = false;
    session.deliveryCredits = [];
    session.unacknowledgedBytes = 0;
  }

  private resume(session: TerminalSession): void {
    if (session.pty) {
      try {
        session.pty.resume();
      } catch {
        throw new TerminalOperationError("INTERNAL");
      }
    }
    session.paused = false;
  }

  private closeOwner(ownerId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId) this.closeSession(session, true);
    }
  }

  private closeSession(session: TerminalSession, flush: boolean): void {
    if (session.closed) return;
    if (flush) this.flush(session);
    if (this.sessions.get(session.terminalId) === session) this.sessions.delete(session.terminalId);
    this.retireSession(session, true);
  }

  private retireSession(session: TerminalSession, kill: boolean): void {
    if (session.closed) return;
    session.closed = true;
    if (session.pendingTimer !== null) {
      this.scheduler.clearTimeout(session.pendingTimer);
      session.pendingTimer = null;
    }
    session.pendingChunks = [];
    session.pendingBytes = 0;
    this.disposeSubscriptions(session);
    const pty = session.pty;
    session.pty = null;
    session.paused = false;
    session.deliveryCredits = [];
    session.unacknowledgedBytes = 0;
    if (kill && pty) {
      try { pty.kill(); } catch { /* The process may already have exited. */ }
    }
  }

  private disposeSubscriptions(session: TerminalSession): void {
    session.dataDisposable?.dispose();
    session.exitDisposable?.dispose();
    session.dataDisposable = null;
    session.exitDisposable = null;
  }

  private requireOrderedSession(request: Extract<
    TerminalBrokerRequest,
    { commandSequence: number }
  >): TerminalSession {
    const session = this.sessions.get(request.terminalId);
    if (!session) throw new TerminalOperationError("NOT_FOUND");
    if (session.ownerId !== request.ownerId) throw new TerminalOperationError("OWNER_MISMATCH");
    if (session.generation !== request.generation) throw new TerminalOperationError("STALE_GENERATION");
    if (request.commandSequence <= session.commandSequence) throw new TerminalOperationError("STALE_COMMAND");
    session.commandSequence = request.commandSequence;
    return session;
  }

  private requireRunningPty(session: TerminalSession): PtyProcess {
    if (!session.pty) throw new TerminalOperationError("NOT_FOUND");
    return session.pty;
  }

  private snapshot(session: TerminalSession): TerminalSnapshot {
    const replay = session.replay.snapshot();
    return {
      brokerId: this.brokerId,
      cols: session.cols,
      cwd: session.cwd,
      exitCode: session.exitCode,
      generation: session.generation,
      ownerId: session.ownerId,
      replay: replay.chunks,
      rows: session.rows,
      sequence: session.sequence,
      shell: session.shell,
      status: session.pty ? "running" : "exited",
      terminalId: session.terminalId,
      truncated: replay.truncated,
    };
  }

  private emit(event: TerminalEvent): boolean {
    try {
      this.onEvent({
        brokerId: this.brokerId,
        event,
        protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
        type: "event",
      });
      return true;
    } catch {
      return false;
    }
  }

  private success(
    request: TerminalBrokerRequest,
    snapshot?: TerminalSnapshot,
  ): TerminalResponseMessage {
    const response = {
      brokerId: this.brokerId,
      ok: true as const,
      protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      requestType: request.type,
      type: "response" as const,
    };
    if (request.type === "open" || request.type === "restart") {
      return { ...response, requestType: request.type, snapshot: snapshot as TerminalSnapshot };
    }
    return response as TerminalResponseMessage;
  }

  private failure(request: TerminalBrokerRequest, code: TerminalBrokerErrorCode): TerminalResponseMessage {
    return {
      brokerId: this.brokerId,
      error: { code, message: PUBLIC_ERROR_MESSAGES[code] },
      ok: false,
      protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      requestType: request.type,
      type: "response",
    };
  }

  private mapError(error: unknown): TerminalBrokerErrorCode {
    return error instanceof TerminalOperationError ? error.code : "INTERNAL";
  }

  private isCurrent(session: TerminalSession, pty: PtyProcess): boolean {
    return !session.closed
      && this.sessions.get(session.terminalId) === session
      && session.pty === pty;
  }

  private generationKey(ownerId: number, terminalId: string): string {
    return `${ownerId}\u0000${terminalId}`;
  }
}
