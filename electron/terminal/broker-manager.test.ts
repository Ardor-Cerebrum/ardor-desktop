import { describe, expect, test } from "bun:test";

import { TerminalBrokerManager } from "./broker-manager.js";
import { TERMINAL_BROKER_PROTOCOL_VERSION, TERMINAL_LIMITS, type TerminalEventMessage } from "./protocol.js";
import type { PtyExitEvent, PtyHost, PtyProcess, PtySpawnRequest } from "./pty-host.js";
import { PtyHostError } from "./pty-host.js";
import type { TerminalShellProfileCatalog } from "./shell-profile.js";

class FakePty implements PtyProcess {
  readonly calls: Array<readonly [string, ...unknown[]]> = [];
  readonly pid: number;
  dataDisposals = 0;
  exitDisposals = 0;
  readonly throwOn = new Set<string>();
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly historicalDataListeners: Array<(data: string) => void> = [];
  private readonly historicalExitListeners: Array<(event: PtyExitEvent) => void> = [];

  constructor(pid: number) { this.pid = pid; }
  private call(name: string, ...args: unknown[]): void {
    this.calls.push([name, ...args]);
    if (this.throwOn.has(name)) throw new Error(`fake ${name} failure`);
  }
  kill(signal?: string): void { this.call("kill", signal); }
  pause(): void { this.call("pause"); }
  resize(cols: number, rows: number): void { this.call("resize", cols, rows); }
  resume(): void { this.call("resume"); }
  write(data: string): void { this.call("write", data); }
  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    this.historicalDataListeners.push(listener);
    return { dispose: () => { if (this.dataListeners.delete(listener)) this.dataDisposals += 1; } };
  }
  onExit(listener: (event: PtyExitEvent) => void) {
    this.exitListeners.add(listener);
    this.historicalExitListeners.push(listener);
    return { dispose: () => { if (this.exitListeners.delete(listener)) this.exitDisposals += 1; } };
  }
  emitData(data: string): void { for (const listener of [...this.dataListeners]) listener(data); }
  emitExit(event: PtyExitEvent): void { for (const listener of [...this.exitListeners]) listener(event); }
  emitStaleData(data: string): void { for (const listener of this.historicalDataListeners) listener(data); }
  emitStaleExit(event: PtyExitEvent): void { for (const listener of this.historicalExitListeners) listener(event); }
}

class FakeHost implements PtyHost {
  readonly catalog: TerminalShellProfileCatalog = {
    defaultProfileId: "pwsh",
    profiles: [
      { id: "pwsh", label: "PowerShell 7" },
      { id: "git-bash", label: "Git Bash" },
    ],
  };
  readonly ptys: FakePty[] = [];
  readonly requests: PtySpawnRequest[] = [];
  nextError: unknown = null;
  listProfiles() { return this.catalog; }
  spawn(request: PtySpawnRequest) {
    this.requests.push({ ...request });
    if (this.nextError) {
      const error = this.nextError;
      this.nextError = null;
      throw error;
    }
    const pty = new FakePty(this.ptys.length + 1);
    this.ptys.push(pty);
    const profileId = request.profileId ?? this.catalog.defaultProfileId ?? "system";
    return { cwd: request.cwd ?? "/home/ardor", profileId, pty, shell: profileId === "git-bash" ? "bash.exe" : "pwsh.exe" };
  }
}

class FakeScheduler {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { callback: () => void; due: number }>();
  readonly setTimeout = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { callback, due: this.now + delay });
    return id;
  };
  readonly clearTimeout = (id: unknown): void => { this.tasks.delete(id as number); };
  advance(milliseconds: number): void {
    this.now += milliseconds;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= this.now)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!due) return;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

const envelope = {
  brokerId: "broker:one",
  protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
} as const;

function openRequest(ownerId = 7, terminalId = "terminal:one") {
  return {
    ...envelope,
    cols: 80,
    ownerId,
    requestId: `open:${ownerId}:${terminalId}`,
    rows: 24,
    terminalId,
    type: "open" as const,
  };
}

function orderedIdentity(
  commandSequence: number,
  generation = 1,
  ownerId = 7,
  terminalId = "terminal:one",
) {
  return {
    ...envelope,
    commandSequence,
    generation,
    ownerId,
    terminalId,
  };
}

function createHarness() {
  const events: TerminalEventMessage[] = [];
  const host = new FakeHost();
  const scheduler = new FakeScheduler();
  const manager = new TerminalBrokerManager({
    brokerId: envelope.brokerId,
    host,
    onEvent: (message) => events.push(message),
    scheduler,
  });
  return { events, host, manager, scheduler };
}

describe("TerminalBrokerManager", () => {
  test("lists profiles and applies a selected profile to open and atomic restart", () => {
    const { host, manager } = createHarness();
    expect(manager.handle({ ...envelope, requestId: "profiles", type: "listProfiles" })).toEqual({
      ...envelope,
      catalog: host.catalog,
      ok: true,
      requestId: "profiles",
      requestType: "listProfiles",
      type: "response",
    });

    expect(manager.handle({ ...openRequest(), profileId: "pwsh" })).toMatchObject({
      ok: true,
      snapshot: { profileId: "pwsh", shell: "pwsh.exe" },
    });
    expect(host.requests[0]).toEqual({ cols: 80, cwd: undefined, profileId: "pwsh", rows: 24 });

    expect(manager.handle({
      ...orderedIdentity(1),
      profileId: "git-bash",
      requestId: "restart:git-bash",
      type: "restart",
    })).toMatchObject({
      ok: true,
      snapshot: { generation: 2, profileId: "git-bash", shell: "bash.exe" },
    });
    expect(host.requests[1]).toEqual({ cols: 80, cwd: "/home/ardor", profileId: "git-bash", rows: 24 });
    expect(host.ptys[0]?.calls).toContainEqual(["kill", undefined]);
  });

  test("maps an unavailable selected profile without replacing the running terminal", () => {
    const { host, manager } = createHarness();
    manager.handle({ ...openRequest(), profileId: "pwsh" });
    host.nextError = new PtyHostError("SHELL_UNAVAILABLE");

    expect(manager.handle({
      ...orderedIdentity(1),
      profileId: "git-bash",
      requestId: "restart:unavailable",
      type: "restart",
    })).toMatchObject({ error: { code: "SHELL_UNAVAILABLE" }, ok: false });
    expect(manager.handle({ ...openRequest(), requestId: "reattach" })).toMatchObject({
      ok: true,
      snapshot: { generation: 1, profileId: "pwsh", status: "running" },
    });
    expect(host.ptys[0]?.calls).not.toContainEqual(["kill", undefined]);
  });

  test("opens one PTY, flushes pending data into an atomic same-owner attachment, and rejects owner collision", () => {
    const { events, host, manager } = createHarness();
    const opened = manager.handle(openRequest());
    expect(opened).toMatchObject({
      brokerId: envelope.brokerId,
      ok: true,
      requestType: "open",
      snapshot: {
        cols: 80,
        cwd: "/home/ardor",
        generation: 1,
        ownerId: 7,
        profileId: "pwsh",
        replay: [],
        rows: 24,
        sequence: 0,
        shell: "pwsh.exe",
        status: "running",
        terminalId: "terminal:one",
      },
    });
    expect(host.ptys).toHaveLength(1);

    host.ptys[0]?.emitData("prompt $ ");
    const attached = manager.handle({ ...openRequest(), requestId: "open:again" });
    expect(attached).toMatchObject({ ok: true, snapshot: { replay: [{ data: "prompt $ ", sequence: 1 }], sequence: 1 } });
    expect(events).toEqual([expect.objectContaining({ event: expect.objectContaining({ data: "prompt $ ", sequence: 1 }) })]);
    expect(host.ptys).toHaveLength(1);

    expect(manager.handle(openRequest(8))).toMatchObject({
      error: { code: "OWNER_MISMATCH" },
      ok: false,
      requestType: "open",
    });
    expect(host.ptys).toHaveLength(1);
  });

  test("enforces retained per-owner and global session limits before spawning", () => {
    const perOwner = createHarness();
    for (let index = 0; index < TERMINAL_LIMITS.MAX_SESSIONS_PER_OWNER; index += 1) {
      expect(perOwner.manager.handle(openRequest(7, `terminal:${index}`))).toMatchObject({ ok: true });
    }
    expect(perOwner.manager.handle(openRequest(7, "terminal:overflow"))).toMatchObject({
      error: { code: "SESSION_LIMIT" }, ok: false,
    });
    expect(perOwner.host.ptys).toHaveLength(TERMINAL_LIMITS.MAX_SESSIONS_PER_OWNER);

    const global = createHarness();
    for (let ownerId = 1; ownerId <= 4; ownerId += 1) {
      for (let index = 0; index < TERMINAL_LIMITS.MAX_SESSIONS_PER_OWNER; index += 1) {
        expect(global.manager.handle(openRequest(ownerId, `terminal:${ownerId}:${index}`))).toMatchObject({ ok: true });
      }
    }
    expect(global.manager.handle(openRequest(5, "terminal:global-overflow"))).toMatchObject({
      error: { code: "SESSION_LIMIT" }, ok: false,
    });
    expect(global.host.ptys).toHaveLength(TERMINAL_LIMITS.MAX_SESSIONS_GLOBAL);
  });

  test("rejects stale ordering for every generation-bound command and old-generation mutations after restart", () => {
    const { host, manager } = createHarness();
    manager.handle(openRequest());
    const first = host.ptys[0] as FakePty;
    expect(manager.handle({ ...orderedIdentity(1), data: "first", requestId: "write:1", type: "write" })).toMatchObject({ ok: true });

    const staleCommands = [
      { ...orderedIdentity(1), requestId: "detach:stale", type: "detach" as const },
      { ...orderedIdentity(1), data: "stale", requestId: "write:stale", type: "write" as const },
      { ...orderedIdentity(1), cols: 100, requestId: "resize:stale", rows: 30, type: "resize" as const },
      { ...orderedIdentity(1), requestId: "ack:stale", sequence: 1, type: "ack" as const },
      { ...orderedIdentity(1), requestId: "clear:stale", type: "clear" as const },
      { ...orderedIdentity(1), requestId: "restart:stale", type: "restart" as const },
      { ...orderedIdentity(1), requestId: "close:stale", type: "close" as const },
    ];
    for (const request of staleCommands) {
      expect(manager.handle(request)).toMatchObject({ error: { code: "STALE_COMMAND" }, ok: false });
    }

    const restarted = manager.handle({ ...orderedIdentity(2), requestId: "restart:2", type: "restart" });
    expect(restarted).toMatchObject({ ok: true, snapshot: { generation: 2, sequence: 0 } });
    const replacement = host.ptys[1] as FakePty;
    const oldGenerationCommands = [
      { ...orderedIdentity(100, 1), requestId: "write:old", data: "old", type: "write" as const },
      { ...orderedIdentity(101, 1), requestId: "resize:old", cols: 120, rows: 40, type: "resize" as const },
      { ...orderedIdentity(102, 1), requestId: "close:old", type: "close" as const },
    ];
    for (const request of oldGenerationCommands) {
      expect(manager.handle(request)).toMatchObject({ error: { code: "STALE_GENERATION" }, ok: false });
    }
    expect(manager.handle({ ...orderedIdentity(1, 2), data: "new", requestId: "write:new", type: "write" })).toMatchObject({ ok: true });
    expect(first.calls).toContainEqual(["kill", undefined]);
    expect(replacement.calls).toEqual([["write", "new"]]);
  });

  test("forwards exact raw input and changes dimensions only after native resize succeeds", () => {
    const { host, manager } = createHarness();
    manager.handle(openRequest());
    const pty = host.ptys[0] as FakePty;
    const raw = "line\r\u001b[A\u{1F600}";
    expect(manager.handle({ ...orderedIdentity(1), data: raw, requestId: "write", type: "write" })).toMatchObject({ ok: true });
    expect(manager.handle({ ...orderedIdentity(2), cols: 120, requestId: "resize", rows: 40, type: "resize" })).toMatchObject({ ok: true });
    expect(pty.calls).toEqual([["write", raw], ["resize", 120, 40]]);

    pty.throwOn.add("resize");
    expect(manager.handle({ ...orderedIdentity(3), cols: 140, requestId: "resize:failed", rows: 50, type: "resize" })).toMatchObject({
      error: { code: "INTERNAL" }, ok: false,
    });
    expect(manager.handle({ ...openRequest(), requestId: "reattach" })).toMatchObject({
      ok: true, snapshot: { cols: 120, rows: 40 },
    });
    expect(manager.handle({ ...orderedIdentity(3), data: "retry", requestId: "write:retry", type: "write" })).toMatchObject({
      error: { code: "STALE_COMMAND" }, ok: false,
    });
  });

  test("batches at 16 ms, flushes at 64 KiB, and splits only on complete code points", () => {
    const { events, host, manager, scheduler } = createHarness();
    manager.handle(openRequest());
    const pty = host.ptys[0] as FakePty;
    pty.emitData("small");
    expect(events).toEqual([]);
    scheduler.advance(15);
    expect(events).toEqual([]);
    scheduler.advance(1);
    expect(events.map(({ event }) => event)).toEqual([
      expect.objectContaining({ data: "small", sequence: 1, type: "data" }),
    ]);

    pty.emitData("a".repeat(TERMINAL_LIMITS.OUTPUT_BATCH_BYTES));
    expect(events.at(-1)?.event).toMatchObject({ data: "a".repeat(TERMINAL_LIMITS.OUTPUT_BATCH_BYTES), sequence: 2 });

    const emoji = "\u{1F600}";
    pty.emitData(emoji.repeat(16_385));
    expect(events.at(-1)?.event).toMatchObject({ data: emoji.repeat(16_384), sequence: 3 });
    scheduler.advance(16);
    expect(events.at(-1)?.event).toMatchObject({ data: emoji, sequence: 4 });
  });

  test("retains detached output without events and returns an atomic reattach snapshot", () => {
    const { events, host, manager, scheduler } = createHarness();
    manager.handle(openRequest());
    expect(manager.handle({ ...orderedIdentity(1), requestId: "detach", type: "detach" })).toMatchObject({ ok: true });
    const pty = host.ptys[0] as FakePty;
    pty.emitData("detached");
    scheduler.advance(16);
    expect(events).toEqual([]);

    expect(manager.handle({ ...openRequest(), requestId: "reattach" })).toMatchObject({
      ok: true,
      snapshot: { replay: [{ data: "detached", sequence: 1 }], sequence: 1 },
    });
    pty.emitData("later");
    scheduler.advance(16);
    expect(events.at(-1)?.event).toMatchObject({ data: "later", sequence: 2 });
  });

  test("flushes data before exit/close, disposes subscriptions, and ignores stale callbacks", () => {
    const { events, host, manager } = createHarness();
    manager.handle(openRequest());
    const first = host.ptys[0] as FakePty;
    first.emitData("before-exit");
    first.emitExit({ exitCode: 3 });
    expect(events.map(({ event }) => event.type)).toEqual(["data", "exit"]);
    expect(events.map(({ event }) => event.sequence)).toEqual([1, 2]);
    expect(first.dataDisposals).toBe(1);
    expect(first.exitDisposals).toBe(1);
    first.emitStaleData("ignored");
    first.emitStaleExit({ exitCode: 9 });
    expect(events).toHaveLength(2);
    expect(manager.handle({ ...openRequest(), requestId: "exited" })).toMatchObject({
      snapshot: { exitCode: 3, sequence: 2, status: "exited" },
    });

    manager.handle(openRequest(7, "terminal:close"));
    const closing = host.ptys[1] as FakePty;
    closing.emitData("before-close");
    expect(manager.handle({ ...orderedIdentity(1, 1, 7, "terminal:close"), requestId: "close", type: "close" })).toMatchObject({ ok: true });
    expect(events.at(-1)?.event).toMatchObject({ data: "before-close", type: "data" });
    const eventCount = events.length;
    closing.emitStaleData("ignored");
    closing.emitStaleExit({ exitCode: 0 });
    expect(events).toHaveLength(eventCount);
    expect(closing.calls).toContainEqual(["kill", undefined]);
    expect(closing.dataDisposals).toBe(1);
    expect(closing.exitDisposals).toBe(1);
  });

  test("restarts atomically and consumes ordering even when replacement spawn fails", () => {
    const { events, host, manager } = createHarness();
    manager.handle(openRequest());
    const first = host.ptys[0] as FakePty;
    first.emitData("old-pending");
    const restarted = manager.handle({ ...orderedIdentity(1), cols: 100, requestId: "restart", rows: 30, type: "restart" });
    expect(events.at(-1)?.event).toMatchObject({ data: "old-pending", generation: 1, sequence: 1 });
    expect(restarted).toMatchObject({ ok: true, snapshot: { cols: 100, generation: 2, replay: [], rows: 30, sequence: 0 } });
    expect(first.calls).toContainEqual(["kill", undefined]);
    first.emitStaleData("old-late");
    expect(events).toHaveLength(1);

    const replacement = host.ptys[1] as FakePty;
    host.nextError = new PtyHostError("SPAWN_FAILED", { cause: new Error("secret executable") });
    expect(manager.handle({ ...orderedIdentity(1, 2), requestId: "restart:failed", type: "restart" })).toMatchObject({
      error: { code: "SPAWN_FAILED" }, ok: false,
    });
    expect(replacement.calls).not.toContainEqual(["kill", undefined]);
    expect(manager.handle({ ...orderedIdentity(2, 2), data: "still-alive", requestId: "write:after-failure", type: "write" })).toMatchObject({ ok: true });
    expect(replacement.calls).toContainEqual(["write", "still-alive"]);
  });

  test("bounds replay, persists clear across reattach, and preserves sequence monotonicity", () => {
    const { host, manager } = createHarness();
    manager.handle(openRequest());
    manager.handle({ ...orderedIdentity(1), requestId: "detach", type: "detach" });
    const pty = host.ptys[0] as FakePty;
    for (let index = 0; index < 17; index += 1) {
      pty.emitData(String.fromCharCode(65 + index).repeat(TERMINAL_LIMITS.OUTPUT_BATCH_BYTES));
    }
    const replayed = manager.handle({ ...openRequest(), requestId: "reattach" });
    expect(replayed).toMatchObject({
      snapshot: { sequence: 17, truncated: true },
    });
    if (replayed.ok && replayed.requestType === "open") {
      expect(replayed.snapshot.replay).toHaveLength(16);
      expect(replayed.snapshot.replay[0]).toMatchObject({ data: "B".repeat(TERMINAL_LIMITS.OUTPUT_BATCH_BYTES), sequence: 2 });
    }

    expect(manager.handle({ ...orderedIdentity(2), requestId: "clear", type: "clear" })).toMatchObject({ ok: true });
    expect(manager.handle({ ...orderedIdentity(3), requestId: "detach:again", type: "detach" })).toMatchObject({ ok: true });
    expect(manager.handle({ ...openRequest(), requestId: "reattach:cleared" })).toMatchObject({
      snapshot: { replay: [], sequence: 17, truncated: false },
    });
  });

  test("pauses and resumes once at credit thresholds, validates ack range, and resets credit on detach", () => {
    const { host, manager } = createHarness();
    manager.handle(openRequest());
    const pty = host.ptys[0] as FakePty;
    const batch = "x".repeat(TERMINAL_LIMITS.OUTPUT_BATCH_BYTES);
    for (let index = 0; index < 8; index += 1) pty.emitData(batch);
    expect(pty.calls.filter(([name]) => name === "pause")).toHaveLength(1);

    expect(manager.handle({ ...orderedIdentity(1), requestId: "ack:6", sequence: 6, type: "ack" })).toMatchObject({ ok: true });
    expect(pty.calls.filter(([name]) => name === "resume")).toHaveLength(1);
    expect(manager.handle({ ...orderedIdentity(2), requestId: "ack:repeat", sequence: 6, type: "ack" })).toMatchObject({ ok: true });
    expect(pty.calls.filter(([name]) => name === "resume")).toHaveLength(1);
    expect(manager.handle({ ...orderedIdentity(3), requestId: "ack:beyond", sequence: 999, type: "ack" })).toMatchObject({
      error: { code: "INVALID_REQUEST" }, ok: false,
    });

    for (let index = 0; index < 6; index += 1) pty.emitData(batch);
    expect(pty.calls.filter(([name]) => name === "pause")).toHaveLength(2);
    expect(manager.handle({ ...orderedIdentity(4), requestId: "detach", type: "detach" })).toMatchObject({ ok: true });
    expect(pty.calls.filter(([name]) => name === "resume")).toHaveLength(2);
  });

  test("isolates closeOwner, shuts down idempotently, and fails closed after disposal or broker mismatch", () => {
    const { host, manager } = createHarness();
    manager.handle(openRequest(7, "terminal:a"));
    manager.handle(openRequest(7, "terminal:b"));
    manager.handle(openRequest(8, "terminal:c"));
    expect(manager.handle({ ...envelope, ownerId: 7, requestId: "close-owner", type: "closeOwner" })).toMatchObject({ ok: true });
    expect(host.ptys.slice(0, 2).map((pty) => pty.calls)).toEqual([
      [["kill", undefined]], [["kill", undefined]],
    ]);
    expect(host.ptys[2]?.calls).toEqual([]);

    expect(manager.handle({ ...envelope, requestId: "shutdown", type: "shutdown" })).toMatchObject({ ok: true });
    expect(host.ptys[2]?.calls).toEqual([["kill", undefined]]);
    manager.dispose();
    expect(host.ptys[2]?.calls).toEqual([["kill", undefined]]);
    expect(manager.handle(openRequest(9, "terminal:after"))).toMatchObject({ error: { code: "BROKER_UNAVAILABLE" }, ok: false });

    const other = createHarness();
    expect(other.manager.handle({ ...openRequest(), brokerId: "broker:other" })).toMatchObject({
      brokerId: envelope.brokerId, error: { code: "BROKER_UNAVAILABLE" }, ok: false,
    });
    expect(other.host.ptys).toHaveLength(0);
  });

  test("fails only malformed-output session closed without leaking content", () => {
    const { events, host, manager } = createHarness();
    manager.handle(openRequest(7, "terminal:bad"));
    manager.handle(openRequest(7, "terminal:good"));
    const malformed = "secret\ud800output";
    host.ptys[0]?.emitData(malformed);
    expect(host.ptys[0]?.calls).toContainEqual(["kill", undefined]);
    expect(host.ptys[0]?.dataDisposals).toBe(1);
    expect(host.ptys[0]?.exitDisposals).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({ reason: "Terminal service became unavailable.", sequence: 1, type: "service-lost" });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(manager.handle({ ...orderedIdentity(1, 1, 7, "terminal:good"), data: "ok", requestId: "write:good", type: "write" })).toMatchObject({ ok: true });
    expect(manager.handle({ ...openRequest(7, "terminal:bad"), requestId: "bad:snapshot" })).toMatchObject({
      snapshot: { exitCode: null, replay: [], sequence: 1, status: "exited" },
    });
  });

  test("maps host failures to stable typed responses without sensitive enumerable data", () => {
    const { host, manager } = createHarness();
    const secret = "/private/user/project secret executable";
    host.nextError = new PtyHostError("INVALID_CWD", { cause: new Error(secret) });
    const invalidCwd = manager.handle({ ...openRequest(), cwd: secret });
    expect(invalidCwd).toMatchObject({ error: { code: "INVALID_CWD", message: "Terminal working directory is invalid." }, ok: false });
    expect(JSON.stringify(invalidCwd)).not.toContain(secret);

    host.nextError = new PtyHostError("SPAWN_FAILED", { cause: new Error(secret) });
    const spawnFailed = manager.handle(openRequest());
    expect(spawnFailed).toMatchObject({ error: { code: "SPAWN_FAILED", message: "Terminal process could not be started." }, ok: false });
    expect(JSON.stringify(spawnFailed)).not.toContain(secret);

    host.nextError = new Error(secret);
    const internal = manager.handle(openRequest());
    expect(internal).toMatchObject({ error: { code: "INTERNAL", message: "Terminal operation failed." }, ok: false });
    expect(JSON.stringify(internal)).not.toContain(secret);
  });
});
