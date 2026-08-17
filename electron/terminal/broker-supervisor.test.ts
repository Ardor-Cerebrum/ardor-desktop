import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import { TerminalBrokerSupervisor } from "./broker-supervisor.js";
import { TERMINAL_BROKER_PROTOCOL_VERSION, type TerminalBrokerRequest } from "./protocol.js";

class FakeChild extends EventEmitter {
  readonly sent: unknown[] = [];
  killCalls = 0;
  postMessageError = false;
  postMessage(message: unknown): void {
    if (this.postMessageError) throw new Error("IPC unavailable");
    this.sent.push(message);
  }
  kill(): boolean { this.killCalls += 1; return true; }
}

describe("TerminalBrokerSupervisor", () => {
  test("waits for a strict ready message, correlates responses, and forwards strict events", async () => {
    const children: FakeChild[] = [];
    const events: unknown[] = [];
    const ids = ["broker:first"];
    const supervisor = new TerminalBrokerSupervisor({
      createBrokerId: () => ids.shift() ?? "broker:fallback",
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    supervisor.onEvent((event) => events.push(event));

    const ready = supervisor.ensureReady();
    const child = children[0] as FakeChild;
    child.emit("message", { brokerId: "wrong", protocolVersion: 1, type: "ready" });
    child.emit("message", { brokerId: "broker:first", protocolVersion: 1, type: "ready" });
    expect(await ready).toBe("broker:first");

    const request: TerminalBrokerRequest = {
      brokerId: "broker:first",
      cols: 80,
      ownerId: 7,
      protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
      requestId: "request:open",
      rows: 24,
      terminalId: "terminal:one",
      type: "open",
    };
    const responsePromise = supervisor.request(request);
    expect(child.sent).toEqual([request]);
    child.emit("message", {
      brokerId: "broker:first",
      event: {
        data: "prompt",
        generation: 1,
        ownerId: 7,
        sequence: 1,
        terminalId: "terminal:one",
        type: "data",
      },
      protocolVersion: 1,
      type: "event",
    });
    child.emit("message", {
      brokerId: "broker:first",
      ok: true,
      protocolVersion: 1,
      requestId: "other",
      requestType: "close",
      type: "response",
    });
    const response = {
      brokerId: "broker:first",
      ok: true,
      protocolVersion: 1,
      requestId: "request:open",
      requestType: "open",
      snapshot: {
        brokerId: "broker:first", cols: 80, cwd: "/home", exitCode: null, generation: 1,
        ownerId: 7, replay: [], rows: 24, sequence: 0, shell: "zsh", status: "running",
        terminalId: "terminal:one", truncated: false,
      },
      type: "response",
    } as const;
    child.emit("message", response);
    expect(await responsePromise).toEqual(response);
    expect(events).toHaveLength(1);
  });

  test("invalidates pending work on crash and starts a fresh broker identity", async () => {
    const children: FakeChild[] = [];
    const unavailable: string[] = [];
    const ids = ["broker:first", "broker:second"];
    const supervisor = new TerminalBrokerSupervisor({
      createBrokerId: () => ids.shift() ?? "broker:fallback",
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    supervisor.onUnavailable((brokerId) => unavailable.push(brokerId));

    const firstReady = supervisor.ensureReady();
    const first = children[0] as FakeChild;
    first.emit("message", { brokerId: "broker:first", protocolVersion: 1, type: "ready" });
    await firstReady;
    const pending = supervisor.request({
      brokerId: "broker:first",
      cols: 80,
      ownerId: 7,
      protocolVersion: 1,
      requestId: "request:open",
      rows: 24,
      terminalId: "terminal:one",
      type: "open",
    });
    first.emit("exit", 1);

    await expect(pending).rejects.toThrow("Terminal service is unavailable.");
    expect(unavailable).toEqual(["broker:first"]);
    const secondReady = supervisor.ensureReady();
    const second = children[1] as FakeChild;
    second.emit("message", { brokerId: "broker:second", protocolVersion: 1, type: "ready" });
    await expect(secondReady).resolves.toBe("broker:second");
  });

  test("recycles a ready broker when a request times out", async () => {
    const children: FakeChild[] = [];
    const unavailable: string[] = [];
    const ids = ["broker:first", "broker:second"];
    const supervisor = new TerminalBrokerSupervisor({
      createBrokerId: () => ids.shift() ?? "broker:fallback",
      requestTimeoutMs: 5,
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    supervisor.onUnavailable((brokerId) => unavailable.push(brokerId));

    const firstReady = supervisor.ensureReady();
    const first = children[0] as FakeChild;
    first.emit("message", { brokerId: "broker:first", protocolVersion: 1, type: "ready" });
    await firstReady;
    const pending = supervisor.request({
      brokerId: "broker:first",
      cols: 80,
      ownerId: 7,
      protocolVersion: 1,
      requestId: "request:open",
      rows: 24,
      terminalId: "terminal:one",
      type: "open",
    });

    await expect(pending).rejects.toThrow("Terminal service is unavailable.");
    expect(first.killCalls).toBe(1);
    expect(unavailable).toEqual(["broker:first"]);

    const secondReady = supervisor.ensureReady();
    const second = children[1] as FakeChild;
    second.emit("message", { brokerId: "broker:second", protocolVersion: 1, type: "ready" });
    await expect(secondReady).resolves.toBe("broker:second");
  });

  test("recycles the broker when posting a request fails synchronously", async () => {
    const children: FakeChild[] = [];
    const unavailable: string[] = [];
    const ids = ["broker:first", "broker:second"];
    const supervisor = new TerminalBrokerSupervisor({
      createBrokerId: () => ids.shift() ?? "broker:fallback",
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    supervisor.onUnavailable((brokerId) => unavailable.push(brokerId));

    const firstReady = supervisor.ensureReady();
    const first = children[0] as FakeChild;
    first.emit("message", { brokerId: "broker:first", protocolVersion: 1, type: "ready" });
    await firstReady;
    first.postMessageError = true;

    await expect(supervisor.request({
      brokerId: "broker:first",
      cols: 80,
      ownerId: 7,
      protocolVersion: 1,
      requestId: "request:open",
      rows: 24,
      terminalId: "terminal:one",
      type: "open",
    })).rejects.toThrow("Terminal service is unavailable.");
    expect(first.killCalls).toBe(1);
    expect(unavailable).toEqual(["broker:first"]);

    const secondReady = supervisor.ensureReady();
    const second = children[1] as FakeChild;
    second.emit("message", { brokerId: "broker:second", protocolVersion: 1, type: "ready" });
    await expect(secondReady).resolves.toBe("broker:second");
  });

  test("kills a broker that never announces readiness", async () => {
    const children: FakeChild[] = [];
    const supervisor = new TerminalBrokerSupervisor({
      createBrokerId: () => "broker:stalled",
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      startTimeoutMs: 5,
    });

    await expect(supervisor.ensureReady()).rejects.toThrow("Terminal service is unavailable.");
    expect(children[0]?.killCalls).toBe(1);
  });

  test("requests graceful shutdown, force-cleans the child, and suppresses crash notification", async () => {
    const children: FakeChild[] = [];
    const unavailable: string[] = [];
    const supervisor = new TerminalBrokerSupervisor({
      createBrokerId: () => "broker:first",
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    supervisor.onUnavailable((brokerId) => unavailable.push(brokerId));
    const ready = supervisor.ensureReady();
    const child = children[0] as FakeChild;
    child.emit("message", { brokerId: "broker:first", protocolVersion: 1, type: "ready" });
    await ready;

    const shutdown = supervisor.shutdown();
    const request = child.sent[0] as TerminalBrokerRequest;
    expect(request.type).toBe("shutdown");
    child.emit("message", {
      brokerId: "broker:first",
      ok: true,
      protocolVersion: 1,
      requestId: request.requestId,
      requestType: "shutdown",
      type: "response",
    });
    await shutdown;

    expect(child.killCalls).toBe(1);
    expect(unavailable).toEqual([]);
    await expect(supervisor.ensureReady()).rejects.toThrow("Terminal service is unavailable.");
  });
});
