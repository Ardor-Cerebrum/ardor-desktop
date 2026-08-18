import { randomUUID } from "node:crypto";

import {
  TERMINAL_BROKER_PROTOCOL_VERSION,
  type TerminalBrokerErrorCode,
  type TerminalBrokerRequest,
  type TerminalEventMessage,
  type TerminalRequestType,
  type TerminalResponseMessage,
} from "./protocol.js";
import type {
  TerminalClientEvent,
  TerminalClientOpenRequest,
  TerminalClientResponse,
  TerminalClientRestartRequest,
  TerminalClientSnapshot,
} from "./client-contract.js";

export interface TerminalBrokerTransport {
  ensureReady(): Promise<string>;
  onEvent(listener: (message: TerminalEventMessage) => void): () => void;
  onUnavailable(listener: (brokerId: string) => void): () => void;
  request(request: TerminalBrokerRequest): Promise<TerminalResponseMessage>;
}

export interface TerminalGatewayOptions {
  readonly createRequestId?: () => string;
  readonly transport: TerminalBrokerTransport;
}

interface GatewaySession {
  brokerId: string;
  brokerGeneration: number;
  commandSequence: number;
  generation: number;
  lastEventSequence: number;
  ownerId: number;
  recovering: boolean;
  terminalId: string;
}

const LOCAL_ERROR_MESSAGES: Readonly<Partial<Record<TerminalBrokerErrorCode, string>>> = Object.freeze({
  BROKER_UNAVAILABLE: "Terminal service is unavailable.",
  NOT_FOUND: "Terminal session is unavailable.",
  OWNER_MISMATCH: "Terminal session belongs to another owner.",
  STALE_GENERATION: "Terminal generation is stale.",
});
const SERVICE_LOST_REASON = "Terminal service became unavailable.";

export class TerminalGateway {
  private readonly createRequestId: () => string;
  private readonly eventListeners = new Set<(ownerId: number, event: TerminalClientEvent) => void>();
  private readonly generationCounters = new Map<string, number>();
  private readonly pendingRestartEvents = new Map<string, TerminalEventMessage[]>();
  private readonly restartingTerminals = new Set<string>();
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly transport: TerminalBrokerTransport;
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeUnavailable: () => void;

  constructor(options: TerminalGatewayOptions) {
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.transport = options.transport;
    this.unsubscribeEvent = this.transport.onEvent((message) => this.handleEvent(message));
    this.unsubscribeUnavailable = this.transport.onUnavailable((brokerId) => this.handleUnavailable(brokerId));
  }

  onEvent(listener: (ownerId: number, event: TerminalClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async listProfiles(): Promise<TerminalClientResponse> {
    let brokerId: string;
    try {
      brokerId = await this.transport.ensureReady();
    } catch {
      return this.localFailure("listProfiles", "BROKER_UNAVAILABLE");
    }
    const response = await this.send({
      brokerId,
      protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
      requestId: this.createRequestId(),
      type: "listProfiles",
    });
    return this.toClientResponse(response);
  }

  async open(
    ownerId: number,
    terminalId: string,
    request: TerminalClientOpenRequest,
  ): Promise<TerminalClientResponse> {
    const existing = this.sessions.get(terminalId);
    if (existing && existing.ownerId !== ownerId) return this.localFailure("open", "OWNER_MISMATCH");

    let brokerId: string;
    try {
      brokerId = await this.transport.ensureReady();
    } catch {
      return this.localFailure("open", "BROKER_UNAVAILABLE");
    }
    if (existing && existing.brokerId !== brokerId) {
      this.sessions.delete(terminalId);
      return this.localFailure("open", "BROKER_UNAVAILABLE");
    }

    const response = await this.send({
      brokerId,
      cols: request.cols,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ownerId,
      ...(request.profileId === undefined ? {} : { profileId: request.profileId }),
      protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
      requestId: this.createRequestId(),
      rows: request.rows,
      terminalId,
      type: "open",
    });
    if (response.ok && response.requestType === "open") {
      const generationKey = this.generationKey(ownerId, terminalId);
      const generation = (this.generationCounters.get(generationKey) ?? 0) + 1;
      this.generationCounters.set(generationKey, generation);
      this.sessions.set(terminalId, {
        brokerId,
        brokerGeneration: response.snapshot.generation,
        commandSequence: existing?.commandSequence ?? 0,
        generation,
        lastEventSequence: response.snapshot.sequence,
        ownerId,
        recovering: false,
        terminalId,
      });
      return this.toClientResponse(response, generation);
    }
    return this.toClientResponse(response);
  }

  detach(ownerId: number, terminalId: string, generation: number): Promise<TerminalClientResponse> {
    return this.command(ownerId, terminalId, generation, "detach", () => ({}));
  }

  write(
    ownerId: number,
    terminalId: string,
    generation: number,
    data: string,
  ): Promise<TerminalClientResponse> {
    return this.command(ownerId, terminalId, generation, "write", () => ({ data }));
  }

  resize(
    ownerId: number,
    terminalId: string,
    generation: number,
    cols: number,
    rows: number,
  ): Promise<TerminalClientResponse> {
    return this.command(ownerId, terminalId, generation, "resize", () => ({ cols, rows }));
  }

  ack(
    ownerId: number,
    terminalId: string,
    generation: number,
    sequence: number,
  ): Promise<TerminalClientResponse> {
    return this.command(ownerId, terminalId, generation, "ack", () => ({ sequence }));
  }

  clear(ownerId: number, terminalId: string, generation: number): Promise<TerminalClientResponse> {
    return this.command(ownerId, terminalId, generation, "clear", () => ({}));
  }

  close(ownerId: number, terminalId: string, generation: number): Promise<TerminalClientResponse> {
    return this.command(ownerId, terminalId, generation, "close", () => ({}));
  }

  restart(
    ownerId: number,
    terminalId: string,
    generation: number,
    restart: TerminalClientRestartRequest,
  ): Promise<TerminalClientResponse> {
    return this.command(ownerId, terminalId, generation, "restart", () => ({
      ...(restart.cols === undefined ? {} : { cols: restart.cols }),
      ...(restart.cwd === undefined ? {} : { cwd: restart.cwd }),
      ...(restart.profileId === undefined ? {} : { profileId: restart.profileId }),
      ...(restart.rows === undefined ? {} : { rows: restart.rows }),
    }));
  }

  beginOwnerRecovery(ownerId: number): void {
    for (const session of this.sessions.values()) {
      if (session.ownerId === ownerId) session.recovering = true;
    }
  }

  async closeRecovering(ownerId: number): Promise<void> {
    const recovering = [...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId && session.recovering);
    await Promise.all(recovering.map((session) =>
      this.close(ownerId, session.terminalId, session.generation)));
  }

  async closeOwner(ownerId: number): Promise<void> {
    const owned = [...this.sessions.values()].filter((session) => session.ownerId === ownerId);
    if (owned.length === 0) return;
    const brokerId = owned[0]?.brokerId;
    for (const session of owned) this.sessions.delete(session.terminalId);
    if (!brokerId || owned.some((session) => session.brokerId !== brokerId)) return;
    try {
      const currentBrokerId = await this.transport.ensureReady();
      if (currentBrokerId !== brokerId) return;
      await this.send({
        brokerId,
        ownerId,
        protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
        requestId: this.createRequestId(),
        type: "closeOwner",
      });
    } catch {
      // Owner cleanup is best effort after the broker has already become unavailable.
    }
  }

  dispose(): void {
    this.unsubscribeEvent();
    this.unsubscribeUnavailable();
    this.eventListeners.clear();
    this.sessions.clear();
  }

  private async command(
    ownerId: number,
    terminalId: string,
    generation: number,
    type: Exclude<TerminalRequestType, "closeOwner" | "listProfiles" | "open" | "shutdown">,
    payload: () => Record<string, unknown>,
  ): Promise<TerminalClientResponse> {
    const session = this.sessions.get(terminalId);
    if (!session) return this.localFailure(type, "NOT_FOUND");
    if (session.ownerId !== ownerId) return this.localFailure(type, "OWNER_MISMATCH");
    if (session.generation !== generation) return this.localFailure(type, "STALE_GENERATION");

    let brokerId: string;
    try {
      brokerId = await this.transport.ensureReady();
    } catch {
      return this.localFailure(type, "BROKER_UNAVAILABLE");
    }
    if (session.brokerId !== brokerId) {
      this.sessions.delete(terminalId);
      return this.localFailure(type, "BROKER_UNAVAILABLE");
    }

    session.commandSequence += 1;
    const request = {
      brokerId,
      commandSequence: session.commandSequence,
      generation: session.brokerGeneration,
      ownerId,
      ...payload(),
      protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
      requestId: this.createRequestId(),
      terminalId,
      type,
    } as TerminalBrokerRequest;
    if (type === "restart") this.restartingTerminals.add(terminalId);
    const response = await this.send(request);
    if (response.ok && response.requestType === "restart") {
      session.brokerGeneration = response.snapshot.generation;
      session.generation += 1;
      this.generationCounters.set(this.generationKey(ownerId, terminalId), session.generation);
      session.commandSequence = 0;
      session.lastEventSequence = response.snapshot.sequence;
    } else if (response.ok && response.requestType === "close") {
      this.sessions.delete(terminalId);
    }
    if (type === "restart") {
      this.restartingTerminals.delete(terminalId);
      const pending = this.pendingRestartEvents.get(terminalId) ?? [];
      this.pendingRestartEvents.delete(terminalId);
      if (response.ok && response.requestType === "restart") {
        for (const event of pending) this.handleEvent(event);
      }
    }
    return this.toClientResponse(response, session.generation);
  }

  private async send(request: TerminalBrokerRequest): Promise<TerminalResponseMessage> {
    try {
      return await this.transport.request(request);
    } catch {
      return {
        brokerId: request.brokerId,
        error: { code: "BROKER_UNAVAILABLE", message: LOCAL_ERROR_MESSAGES.BROKER_UNAVAILABLE as string },
        ok: false,
        protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        requestType: request.type,
        type: "response",
      };
    }
  }

  private handleEvent(message: TerminalEventMessage): void {
    const session = this.sessions.get(message.event.terminalId);
    if (
      session
      && this.restartingTerminals.has(message.event.terminalId)
      && session.brokerId === message.brokerId
      && session.ownerId === message.event.ownerId
      && session.brokerGeneration !== message.event.generation
    ) {
      this.pendingRestartEvents.set(message.event.terminalId, [...(this.pendingRestartEvents.get(message.event.terminalId) ?? []), message]);
      return;
    }
    if (
      !session
      || session.brokerId !== message.brokerId
      || session.ownerId !== message.event.ownerId
      || session.brokerGeneration !== message.event.generation
      || message.event.sequence <= session.lastEventSequence
    ) return;
    session.lastEventSequence = message.event.sequence;
    const { ownerId, generation: _brokerGeneration, ...eventRest } = message.event;
    const event = { ...eventRest, generation: session.generation } as TerminalClientEvent;
    for (const listener of [...this.eventListeners]) listener(ownerId, event);
  }

  private handleUnavailable(brokerId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.brokerId !== brokerId) continue;
      this.sessions.delete(session.terminalId);
      const event: TerminalClientEvent = {
        generation: session.generation,
        reason: SERVICE_LOST_REASON,
        sequence: session.lastEventSequence + 1,
        terminalId: session.terminalId,
        type: "service-lost",
      };
      for (const listener of [...this.eventListeners]) listener(session.ownerId, event);
    }
  }

  private toClientResponse(response: TerminalResponseMessage, generation?: number): TerminalClientResponse {
    if (!response.ok) {
      return { error: { ...response.error }, ok: false, requestType: response.requestType };
    }
    if (response.requestType === "open" || response.requestType === "restart") {
      const { brokerId: _brokerId, ownerId: _ownerId, ...snapshot } = response.snapshot;
      return { ok: true, requestType: response.requestType, snapshot: { ...snapshot, generation: generation ?? snapshot.generation } };
    }
    if (response.requestType === "listProfiles") {
      return { catalog: response.catalog, ok: true, requestType: response.requestType };
    }
    return { ok: true, requestType: response.requestType };
  }

  private generationKey(ownerId: number, terminalId: string): string {
    return `${ownerId}:${terminalId}`;
  }

  private localFailure(requestType: TerminalRequestType, code: TerminalBrokerErrorCode): TerminalClientResponse {
    return {
      error: { code, message: LOCAL_ERROR_MESSAGES[code] ?? "Terminal operation failed." },
      ok: false,
      requestType,
    };
  }
}
