import { describe, expect, test } from "bun:test";

import { NodePtyHost, type NodePtySpawnAdapter } from "./node-pty-host.js";
import { PtyHostError, type PtyExitEvent, type PtyProcess } from "./pty-host.js";

class FakePty implements PtyProcess {
  readonly pid = 42;
  readonly calls: Array<readonly [string, ...unknown[]]> = [];
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyExitEvent) => void>();

  kill(signal?: string): void { this.calls.push(["kill", signal]); }

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: PtyExitEvent) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  pause(): void { this.calls.push(["pause"]); }
  resize(cols: number, rows: number): void { this.calls.push(["resize", cols, rows]); }
  resume(): void { this.calls.push(["resume"]); }
  write(data: string): void { this.calls.push(["write", data]); }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

function createHost(overrides: ConstructorParameters<typeof NodePtyHost>[0] = {}) {
  return new NodePtyHost({
    currentDirectory: "/current",
    environment: {},
    homeDirectory: "/home/ardor",
    isDirectory: (path) => path === "/home/ardor" || path === "/current",
    isExecutableFile: () => false,
    platform: "linux",
    spawnPty: () => new FakePty(),
    ...overrides,
  });
}

describe("NodePtyHost", () => {
  test("spawns the configured Unix login shell with fixed terminal options and a copied sanitized environment", () => {
    const environment = {
      CUSTOM_VALUE: "preserved",
      ELECTRON_RUN_AS_NODE: "1",
      SHELL: "/usr/local/bin/zsh",
    };
    const originalEnvironment = { ...environment };
    const fakePty = new FakePty();
    const calls: Parameters<NodePtySpawnAdapter>[] = [];
    const spawnPty: NodePtySpawnAdapter = (...args) => {
      calls.push(args);
      return fakePty;
    };
    const host = new NodePtyHost({
      currentDirectory: "/current",
      environment,
      homeDirectory: "/home/ardor",
      isDirectory: (path) => path === "/home/ardor",
      isExecutableFile: (path) => path === "/usr/local/bin/zsh",
      platform: "linux",
      spawnPty,
    });

    const result = host.spawn({ cols: 120, cwd: "/home/ardor/../ardor", rows: 40 });

    expect(result).toEqual({
      cwd: "/home/ardor",
      pty: fakePty,
      shell: "zsh",
    });
    expect(calls).toHaveLength(1);
    const [file, args, options] = calls[0] ?? [];
    expect(file).toBe("/usr/local/bin/zsh");
    expect(args).toEqual(["-l"]);
    expect(options).toEqual({
      cols: 120,
      cwd: "/home/ardor",
      env: {
        COLORTERM: "truecolor",
        CUSTOM_VALUE: "preserved",
        SHELL: "/usr/local/bin/zsh",
        TERM: "xterm-256color",
        TERM_PROGRAM: "Ardor",
      },
      name: "xterm-256color",
      rows: 40,
    });
    expect(options?.env).not.toBe(environment);
    expect(environment).toEqual(originalEnvironment);
  });

  test("uses the platform Unix fallback when SHELL is not an absolute existing executable", () => {
    const calls: Parameters<NodePtySpawnAdapter>[] = [];
    const host = new NodePtyHost({
      currentDirectory: "/current",
      environment: { SHELL: "relative-shell" },
      homeDirectory: "/home/ardor",
      isDirectory: (path) => path === "/home/ardor",
      isExecutableFile: () => false,
      platform: "linux",
      spawnPty: (...args) => {
        calls.push(args);
        return new FakePty();
      },
    });

    expect(host.spawn({ cols: 80, rows: 24 }).shell).toBe("bash");
    expect(calls[0]?.slice(0, 2)).toEqual(["/bin/bash", ["-l"]]);
  });

  test("uses zsh as the macOS fallback", () => {
    const calls: Parameters<NodePtySpawnAdapter>[] = [];
    const host = createHost({
      platform: "darwin",
      spawnPty: (...args) => {
        calls.push(args);
        return new FakePty();
      },
    });

    expect(host.spawn({ cols: 80, rows: 24 }).shell).toBe("zsh");
    expect(calls[0]?.slice(0, 2)).toEqual(["/bin/zsh", ["-l"]]);
  });

  test("uses COMSPEC on Windows and falls back to cmd.exe without caller-controlled arguments", () => {
    const configuredCalls: Parameters<NodePtySpawnAdapter>[] = [];
    const configured = createHost({
      environment: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      homeDirectory: "C:\\Users\\ardor",
      currentDirectory: "C:\\work",
      isDirectory: (path) => path === "C:\\Users\\ardor",
      isExecutableFile: (path) => path === "C:\\Windows\\System32\\cmd.exe",
      platform: "win32",
      spawnPty: (...args) => { configuredCalls.push(args); return new FakePty(); },
    });
    expect(configured.spawn({ cols: 80, rows: 24 })).toMatchObject({ cwd: "C:\\Users\\ardor", shell: "cmd.exe" });
    expect(configuredCalls[0]?.slice(0, 2)).toEqual(["C:\\Windows\\System32\\cmd.exe", []]);

    const fallbackCalls: Parameters<NodePtySpawnAdapter>[] = [];
    const fallback = createHost({
      environment: { COMSPEC: "relative.exe" },
      homeDirectory: "C:\\Users\\ardor",
      currentDirectory: "C:\\work",
      isDirectory: (path) => path === "C:\\Users\\ardor",
      isExecutableFile: () => false,
      platform: "win32",
      spawnPty: (...args) => { fallbackCalls.push(args); return new FakePty(); },
    });
    fallback.spawn({ cols: 80, rows: 24 });
    expect(fallbackCalls[0]?.slice(0, 2)).toEqual(["cmd.exe", []]);
  });

  test("rejects explicit empty, relative, missing, and file cwd without fallback", () => {
    const host = createHost({
      isDirectory: (path) => path === "/home/ardor" || path === "/current" || path === "/work/dir",
    });
    for (const cwd of ["", "relative", "/missing", "/work/file"]) {
      expect(() => host.spawn({ cols: 80, cwd, rows: 24 })).toThrow(new PtyHostError("INVALID_CWD"));
    }
    expect(host.spawn({ cols: 80, cwd: "/work/dir/../dir", rows: 24 }).cwd).toBe("/work/dir");
  });

  test("chooses a safe absolute home and then current-directory fallback", () => {
    expect(createHost().spawn({ cols: 80, rows: 24 }).cwd).toBe("/home/ardor");
    const currentFallback = createHost({
      homeDirectory: "/missing-home",
      isDirectory: (path) => path === "/current",
    });
    expect(currentFallback.spawn({ cols: 80, rows: 24 }).cwd).toBe("/current");
    expect(() => createHost({
      homeDirectory: "relative-home",
      currentDirectory: "/missing-current",
      isDirectory: () => false,
    })).toThrow(new PtyHostError("INVALID_CWD"));
  });

  test("maps native spawn failures to a stable non-enumerable typed cause", () => {
    const secret = "native secret /private/path";
    const host = createHost({
      spawnPty: () => { throw new Error(secret); },
    });
    let thrown: unknown;
    try { host.spawn({ cols: 80, rows: 24 }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(PtyHostError);
    expect(thrown).toMatchObject({ code: "SPAWN_FAILED", message: "Terminal process could not be started." });
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(Object.keys(thrown as object).sort()).toEqual(["code", "name"]);
  });

  test("returns the native PTY contract without lossy input, events, control, or disposable wrappers", () => {
    const fake = new FakePty();
    const host = createHost({ spawnPty: () => fake });
    const { pty } = host.spawn({ cols: 80, rows: 24 });
    const data: string[] = [];
    const exits: PtyExitEvent[] = [];
    const dataDisposable = pty.onData((value) => data.push(value));
    const exitDisposable = pty.onExit((value) => exits.push(value));
    const raw = "line\r\u001b[A😀";

    pty.write(raw);
    pty.resize(120, 40);
    pty.pause();
    pty.resume();
    pty.kill("SIGTERM");
    fake.emitData(raw);
    fake.emitExit({ exitCode: 7, signal: 15 });

    expect(pty).toBe(fake);
    expect(fake.calls).toEqual([
      ["write", raw], ["resize", 120, 40], ["pause"], ["resume"], ["kill", "SIGTERM"],
    ]);
    expect(data).toEqual([raw]);
    expect(exits).toEqual([{ exitCode: 7, signal: 15 }]);

    dataDisposable.dispose();
    exitDisposable.dispose();
    fake.emitData("ignored");
    fake.emitExit({ exitCode: 0 });
    expect(data).toEqual([raw]);
    expect(exits).toEqual([{ exitCode: 7, signal: 15 }]);
  });
});
