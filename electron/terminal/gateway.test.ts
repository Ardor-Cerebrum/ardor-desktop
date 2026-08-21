import { describe, expect, test } from "bun:test";

import { TerminalGateway, type TerminalBrokerTransport } from "./gateway.js";
import type { TerminalBrokerRequest, TerminalEventMessage, TerminalResponseMessage } from "./protocol.js";

class FakeTransport implements TerminalBrokerTransport {
  brokerId = "broker:first";
  readonly requests: TerminalBrokerRequest[] = [];
  responder: (request: TerminalBrokerRequest) => TerminalResponseMessage = (request) => ({
    brokerId: request.brokerId,
    ok: true,
    protocolVersion: 1,
    requestId: request.requestId,
    requestType: request.type,
    type: "response",
  } as TerminalResponseMessage);
  private eventListener: ((message: TerminalEventMessage) => void) | null = null;
  private unavailableListener: ((brokerId: string) => void) | null = null;

  ensureReady(): Promise<string> { return Promise.resolve(this.brokerId); }
  request(request: TerminalBrokerRequest): Promise<TerminalResponseMessage> {
    this.requests.push(request);
    return Promise.resolve(this.responder(request));
  }
  onEvent(listener: (message: TerminalEventMessage) => void): () => void {
    this.eventListener = listener;
    return () => { this.eventListener = null; };
  }
  onUnavailable(listener: (brokerId: string) => void): () => void {
    this.unavailableListener = listener;
    return () => { this.unavailableListener = null; };
  }
  emit(message: TerminalEventMessage): void { this.eventListener?.(message); }
  crash(): void { this.unavailableListener?.(this.brokerId); }
}

function snapshotResponse(request: TerminalBrokerRequest, generation: number): TerminalResponseMessage {
  if (request.type !== "open" && request.type !== "restart") throw new Error("snapshot request expected");
  return {
    brokerId: request.brokerId,
    ok: true,
    protocolVersion: 1,
    requestId: request.requestId,
    requestType: request.type,
    snapshot: {
      brokerId: request.brokerId,
      cols: "cols" in request && request.cols !== undefined ? request.cols : 80,
      cwd: "cwd" in request && request.cwd ? request.cwd : "/home/ardor",
      exitCode: null,
      generation,
      ownerId: request.ownerId,
      profileId: "profileId" in request && request.profileId ? request.profileId : "system",
      replay: [],
      rows: "rows" in request && request.rows !== undefined ? request.rows : 24,
      sequence: 0,
      shell: "zsh",
      status: "running",
      terminalId: request.terminalId,
      truncated: false,
    },
    type: "response",
  };
}

describe("TerminalGateway", () => {
  test("lists profiles and forwards selected profile IDs without exposing executable paths", async () => {
    const transport = new FakeTransport();
    const gateway = new TerminalGateway({ transport, createRequestId: () => "request" });
    transport.responder = (request) => {
      if (request.type === "listProfiles") {
        return {
          brokerId: request.brokerId,
          catalog: {
            defaultProfileId: "wsl-default",
            profiles: [{ id: "wsl-default", label: "WSL (default)" }, { id: "pwsh", label: "PowerShell 7" }],
          },
          ok: true,
          protocolVersion: 1,
          requestId: request.requestId,
          requestType: request.type,
          type: "response",
        };
      }
      return snapshotResponse(request, request.type === "restart" ? 2 : 1);
    };

    expect(await gateway.listProfiles()).toMatchObject({
      catalog: { defaultProfileId: "wsl-default", profiles: [{ id: "wsl-default" }, { id: "pwsh" }] },
      ok: true,
      requestType: "listProfiles",
    });
    expect(await gateway.open(7, "terminal:one", { cols: 80, profileId: "pwsh", rows: 24 })).toMatchObject({
      ok: true,
      snapshot: { profileId: "pwsh" },
    });
    expect(await gateway.restart(7, "terminal:one", 1, { profileId: "wsl-default" })).toMatchObject({
      ok: true,
      snapshot: { generation: 2, profileId: "wsl-default" },
    });
    expect(transport.requests).toEqual([
      expect.objectContaining({ type: "listProfiles" }),
      expect.objectContaining({ profileId: "pwsh", type: "open" }),
      expect.objectContaining({ profileId: "wsl-default", type: "restart" }),
    ]);
    expect(JSON.stringify(transport.requests)).not.toContain("executablePath");
  });

  test("owns generation/command ordering and rejects delayed renderer commands after restart", async () => {
    const transport = new FakeTransport();
    let nextId = 1;
    const gateway = new TerminalGateway({ transport, createRequestId: () => `request:${nextId++}` });
    transport.responder = (request) => snapshotResponse(request, request.type === "restart" ? 2 : 1);

    expect(await gateway.open(7, "terminal:one", { cols: 80, rows: 24 })).toMatchObject({
      ok: true, snapshot: { generation: 1, terminalId: "terminal:one" },
    });
    transport.responder = (request) => request.type === "restart"
      ? snapshotResponse(request, 2)
      : ({ brokerId: request.brokerId, ok: true, protocolVersion: 1, requestId: request.requestId, requestType: request.type, type: "response" } as TerminalResponseMessage);
    expect(await gateway.write(7, "terminal:one", 1, "pwd\r")).toMatchObject({ ok: true });
    expect(await gateway.restart(7, "terminal:one", 1, {})).toMatchObject({ ok: true, snapshot: { generation: 2 } });
    expect(await gateway.write(7, "terminal:one", 1, "delayed")).toMatchObject({ error: { code: "STALE_GENERATION" }, ok: false });
    expect(await gateway.write(7, "terminal:one", 2, "current")).toMatchObject({ ok: true });

    expect(transport.requests.map((request) => [request.type, "commandSequence" in request ? request.commandSequence : null])).toEqual([
      ["open", null], ["write", 1], ["restart", 2], ["write", 1],
    ]);
  });

  test("advances the client generation on reattach so an old delayed close cannot kill the lease", async () => {
    const transport = new FakeTransport();
    const gateway = new TerminalGateway({ transport, createRequestId: () => "request" });
    transport.responder = (request) => request.type === "open"
      ? snapshotResponse(request, 1)
      : ({ brokerId: request.brokerId, ok: true, protocolVersion: 1, requestId: request.requestId,
          requestType: request.type, type: "response" } as TerminalResponseMessage);

    expect(await gateway.open(7, "terminal:one", { cols: 80, rows: 24 })).toMatchObject({
      ok: true, snapshot: { generation: 1 },
    });
    expect(await gateway.detach(7, "terminal:one", 1)).toMatchObject({ ok: true });
    expect(await gateway.open(7, "terminal:one", { cols: 80, rows: 24 })).toMatchObject({
      ok: true, snapshot: { generation: 2 },
    });
    expect(await gateway.close(7, "terminal:one", 1)).toMatchObject({
      error: { code: "STALE_GENERATION" }, ok: false,
    });
    expect(await gateway.write(7, "terminal:one", 2, "still alive")).toMatchObject({ ok: true });
    expect(transport.requests.map((request) => request.type)).toEqual(["open", "detach", "open", "write"]);
  });

  test("queues new-generation output that races the restart response and releases it in order", async () => {
    const transport = new FakeTransport();
    const events: unknown[] = [];
    const gateway = new TerminalGateway({ transport, createRequestId: () => "request" });
    gateway.onEvent((ownerId, event) => events.push({ ownerId, event }));
    transport.responder = (request) => {
      if (request.type === "restart") {
        transport.emit({
          brokerId: request.brokerId,
          event: {
            data: "new prompt",
            generation: 2,
            ownerId: request.ownerId,
            sequence: 1,
            terminalId: request.terminalId,
            type: "data",
          },
          protocolVersion: 1,
          type: "event",
        });
        return snapshotResponse(request, 2);
      }
      return snapshotResponse(request, 1);
    };

    await gateway.open(7, "terminal:one", { cols: 80, rows: 24 });
    expect(await gateway.restart(7, "terminal:one", 1, {})).toMatchObject({ ok: true, snapshot: { generation: 2 } });
    expect(events).toEqual([
      { ownerId: 7, event: { data: "new prompt", generation: 2, sequence: 1, terminalId: "terminal:one", type: "data" } },
    ]);
  });

  test("routes only current ordered events and marks sessions lost on broker crash", async () => {
    const transport = new FakeTransport();
    const events: unknown[] = [];
    const gateway = new TerminalGateway({ transport, createRequestId: () => "request" });
    gateway.onEvent((ownerId, event) => events.push({ ownerId, event }));
    transport.responder = (request) => snapshotResponse(request, 1);
    await gateway.open(7, "terminal:one", { cols: 80, rows: 24 });

    const event = {
      brokerId: "broker:first",
      event: { data: "prompt", generation: 1, ownerId: 7, sequence: 1, terminalId: "terminal:one", type: "data" },
      protocolVersion: 1,
      type: "event",
    } as const;
    transport.emit(event);
    transport.emit(event);
    transport.crash();
    expect(events).toEqual([
      { ownerId: 7, event: { data: "prompt", generation: 1, sequence: 1, terminalId: "terminal:one", type: "data" } },
      { ownerId: 7, event: expect.objectContaining({ generation: 1, reason: "Terminal service became unavailable.", sequence: 2, type: "service-lost" }) },
    ]);
    expect(await gateway.write(7, "terminal:one", 1, "after-crash")).toMatchObject({ error: { code: "NOT_FOUND" }, ok: false });
  });

  test("advances client generation across broker replacement and translates native identity", async () => {
    const transport = new FakeTransport();
    const events: unknown[] = [];
    const gateway = new TerminalGateway({ transport, createRequestId: () => "request" });
    gateway.onEvent((ownerId, event) => events.push({ ownerId, event }));
    transport.responder = (request) => snapshotResponse(request, 1);

    expect(await gateway.open(7, "terminal:one", { cols: 80, rows: 24 })).toMatchObject({
      ok: true,
      snapshot: { generation: 1 },
    });
    transport.crash();
    transport.brokerId = "broker:second";
    expect(await gateway.open(7, "terminal:one", { cols: 80, rows: 24 })).toMatchObject({
      ok: true,
      snapshot: { generation: 2 },
    });
    transport.responder = (request) => ({
      brokerId: request.brokerId,
      ok: true,
      protocolVersion: 1,
      requestId: request.requestId,
      requestType: request.type,
      type: "response",
    } as TerminalResponseMessage);
    expect(await gateway.write(7, "terminal:one", 1, "stale")).toMatchObject({
      error: { code: "STALE_GENERATION" },
      ok: false,
    });
    expect(await gateway.write(7, "terminal:one", 2, "current")).toMatchObject({ ok: true });
    const writeRequest = transport.requests.at(-1);
    expect(writeRequest).toMatchObject({ brokerId: "broker:second", generation: 1, type: "write" });

    transport.emit({
      brokerId: "broker:second",
      event: {
        data: "new broker",
        generation: 1,
        ownerId: 7,
        sequence: 1,
        terminalId: "terminal:one",
        type: "data",
      },
      protocolVersion: 1,
      type: "event",
    });
    expect(events.at(-1)).toEqual({
      ownerId: 7,
      event: { data: "new broker", generation: 2, sequence: 1, terminalId: "terminal:one", type: "data" },
    });
  });

  test("closes only terminal sessions left unclaimed after renderer recovery", async () => {
    const transport = new FakeTransport();
    const gateway = new TerminalGateway({ transport, createRequestId: () => "request" });
    transport.responder = (request) => request.type === "open"
      ? snapshotResponse(request, 1)
      : ({ brokerId: request.brokerId, ok: true, protocolVersion: 1, requestId: request.requestId,
          requestType: request.type, type: "response" } as TerminalResponseMessage);

    await gateway.open(7, "terminal:one", { cols: 80, rows: 24 });
    await gateway.open(7, "terminal:two", { cols: 80, rows: 24 });
    gateway.beginOwnerRecovery(7);

    expect(await gateway.open(7, "terminal:one", { cols: 80, rows: 24 })).toMatchObject({
      ok: true, snapshot: { generation: 2 },
    });
    await gateway.closeRecovering(7);

    expect(await gateway.write(7, "terminal:one", 2, "recovered")).toMatchObject({ ok: true });
    expect(await gateway.write(7, "terminal:two", 1, "orphaned")).toMatchObject({
      error: { code: "NOT_FOUND" }, ok: false,
    });
    expect(transport.requests.map((request) => [request.type, "terminalId" in request ? request.terminalId : null]))
      .toEqual([
        ["open", "terminal:one"],
        ["open", "terminal:two"],
        ["open", "terminal:one"],
        ["close", "terminal:two"],
        ["write", "terminal:one"],
      ]);
  });
});
