import { afterEach, describe, expect, test } from "bun:test";

import { TerminalManager, type TerminalEvent } from "./manager.js";

class FakePty {
  readonly pid = 42;
  killed = false;
  resizeCalls: Array<[number, number]> = [];
  writes: string[] = [];
  private dataHandler: (data: string) => void = () => undefined;
  private exitHandler: (event: { exitCode: number }) => void = () => undefined;

  kill(): void {
    this.killed = true;
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler;
    return { dispose: () => undefined };
  }

  onExit(handler: (event: { exitCode: number }) => void) {
    this.exitHandler = handler;
    return { dispose: () => undefined };
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push([cols, rows]);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  emitData(data: string): void {
    this.dataHandler(data);
  }

  emitExit(exitCode: number): void {
    this.exitHandler({ exitCode });
  }
}

const managers: TerminalManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

function createHarness() {
  const events: TerminalEvent[] = [];
  const ptys: FakePty[] = [];
  const manager = new TerminalManager({
    environment: { SHELL: "/bin/zsh" },
    homeDirectory: "/tmp",
    onEvent: (_ownerId, event) => events.push(event),
    platform: "darwin",
    spawnTerminal: (_file, _args, _options) => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    },
  });
  managers.push(manager);
  return { events, manager, ptys };
}

describe("TerminalManager", () => {
  test("creates a login shell and reattaches with buffered output", async () => {
    const { events, manager, ptys } = createHarness();
    const first = manager.open(7, "terminal:one", { cols: 100, rows: 30 });
    expect(first).toMatchObject({ cols: 100, cwd: "/tmp", rows: 30, shell: "zsh", status: "running" });

    ptys[0]?.emitData("hello");
    await Bun.sleep(20);
    expect(events).toEqual([
      expect.objectContaining({ data: "hello", terminalId: "terminal:one", type: "data" }),
    ]);
    expect(manager.open(7, "terminal:one")).toMatchObject({ buffer: "hello", generation: 1, sequence: 1 });
    expect(ptys).toHaveLength(1);
  });

  test("flushes pending output before returning an attachment snapshot", () => {
    const { events, manager, ptys } = createHarness();
    manager.open(7, "terminal:one");
    ptys[0]?.emitData("prompt");

    const attached = manager.open(7, "terminal:one");

    expect(attached).toMatchObject({ buffer: "prompt", sequence: 1 });
    expect(events).toEqual([
      expect.objectContaining({ data: "prompt", sequence: 1, terminalId: "terminal:one", type: "data" }),
    ]);
  });

  test("scopes input and resize to the owning window", () => {
    const { manager, ptys } = createHarness();
    manager.open(7, "terminal:one");
    expect(manager.write(7, "terminal:one", "pwd\r")).toBe(true);
    expect(manager.resize(7, "terminal:one", 120, 40)).toBe(true);
    expect(ptys[0]?.writes).toEqual(["pwd\r"]);
    expect(ptys[0]?.resizeCalls).toEqual([[120, 40]]);
    expect(() => manager.write(8, "terminal:one", "nope")).toThrow("another window");
  });

  test("keeps an exited session available for rendering and can restart it", () => {
    const { events, manager, ptys } = createHarness();
    manager.open(7, "terminal:one");
    ptys[0]?.emitExit(3);

    expect(manager.open(7, "terminal:one")).toMatchObject({ exitCode: 3, status: "exited" });
    expect(events.at(-1)).toMatchObject({ exitCode: 3, type: "exit" });

    const restarted = manager.restart(7, "terminal:one");
    expect(restarted).toMatchObject({ buffer: "", generation: 2, status: "running" });
    expect(ptys).toHaveLength(2);
  });

  test("kills every terminal owned by a destroyed window", () => {
    const { manager, ptys } = createHarness();
    manager.open(7, "terminal:one");
    manager.open(7, "terminal:two");
    manager.open(8, "terminal:other");

    manager.closeOwner(7);
    expect(ptys.map((pty) => pty.killed)).toEqual([true, true, false]);
  });
});
