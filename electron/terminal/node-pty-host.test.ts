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
      platform: "linux",
      spawnPty,
    });

    const result = host.spawn({ cols: 120, cwd: "/home/ardor/../ardor", rows: 40 });

    expect(result).toEqual({
      cwd: "/home/ardor",
      profileId: "system",
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

  test("uses the platform Unix fallback when SHELL is not explicitly supported", () => {
    const calls: Parameters<NodePtySpawnAdapter>[] = [];
    const host = new NodePtyHost({
      currentDirectory: "/current",
      environment: { SHELL: "/tmp/attacker-controlled-shell" },
      homeDirectory: "/home/ardor",
      isDirectory: (path) => path === "/home/ardor",
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

  test("discovers only supported Windows shell profiles and prefers WSL by default", () => {
    const existingFiles = new Set([
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\System32\\wsl.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
    ]);
    const host = createHost({
      environment: {
        COMSPEC: "C:\\Users\\attacker\\shell.exe",
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      homeDirectory: "C:\\Users\\ardor",
      currentDirectory: "C:\\work",
      isDirectory: (path) => path === "C:\\Users\\ardor",
      isFile: (path) => existingFiles.has(path),
      platform: "win32",
      probeWsl: () => true,
    });

    expect(host.listProfiles()).toEqual({
      defaultProfileId: "wsl-default",
      profiles: [
        { id: "wsl-default", label: "WSL (default)" },
        { id: "pwsh", label: "PowerShell 7" },
        { id: "windows-powershell", label: "Windows PowerShell" },
        { id: "git-bash", label: "Git Bash" },
        { id: "cmd", label: "Command Prompt" },
      ],
    });
  });

  test("spawns only the selected discovered Windows profile with fixed arguments", () => {
    const calls: Parameters<NodePtySpawnAdapter>[] = [];
    const existingFiles = new Set([
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\System32\\wsl.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
    ]);
    const host = createHost({
      environment: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
      homeDirectory: "C:\\Users\\ardor",
      currentDirectory: "C:\\work",
      isDirectory: (path) => path === "C:\\Users\\ardor",
      isFile: (path) => existingFiles.has(path),
      platform: "win32",
      probeWsl: () => true,
      spawnPty: (...args) => { calls.push(args); return new FakePty(); },
    });

    const cases = [
      ["wsl-default", "C:\\Windows\\System32\\wsl.exe", ["--cd", "~"]],
      ["pwsh", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", ["-NoLogo"]],
      ["windows-powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoLogo"]],
      ["git-bash", "C:\\Program Files\\Git\\bin\\bash.exe", ["--login", "-i"]],
      ["cmd", "C:\\Windows\\System32\\cmd.exe", []],
    ] as const;
    for (const [profileId, file, args] of cases) {
      expect(host.spawn({ cols: 80, profileId, rows: 24 })).toMatchObject({ profileId, shell: file.split("\\").at(-1) });
      expect(calls.at(-1)?.slice(0, 2)).toEqual([file, args]);
    }
  });

  test("falls back to PowerShell and rejects unavailable profile IDs without spawning", () => {
    const calls: Parameters<NodePtySpawnAdapter>[] = [];
    const host = createHost({
      environment: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
      homeDirectory: "C:\\Users\\ardor",
      currentDirectory: "C:\\work",
      isDirectory: (path) => path === "C:\\Users\\ardor",
      isFile: (path) => path === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      platform: "win32",
      probeWsl: () => false,
      spawnPty: (...args) => { calls.push(args); return new FakePty(); },
    });

    expect(host.listProfiles()).toEqual({
      defaultProfileId: "windows-powershell",
      profiles: [{ id: "windows-powershell", label: "Windows PowerShell" }],
    });
    expect(host.spawn({ cols: 80, rows: 24 })).toMatchObject({ profileId: "windows-powershell" });
    expect(() => host.spawn({ cols: 80, profileId: "cmd", rows: 24 })).toThrow(
      new PtyHostError("SHELL_UNAVAILABLE"),
    );
    expect(calls).toHaveLength(1);
  });

  test("discovers a standard per-user Git Bash installation without consulting PATH", () => {
    const calls: Parameters<NodePtySpawnAdapter>[] = [];
    const gitBash = "C:\\Users\\ardor\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    const host = createHost({
      environment: {
        LOCALAPPDATA: "C:\\Users\\ardor\\AppData\\Local",
        PATH: "C:\\Users\\attacker\\bin",
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      homeDirectory: "C:\\Users\\ardor",
      currentDirectory: "C:\\work",
      isDirectory: (path) => path === "C:\\Users\\ardor",
      isFile: (path) => path === gitBash,
      platform: "win32",
      probeWsl: () => false,
      spawnPty: (...args) => { calls.push(args); return new FakePty(); },
    });

    expect(host.listProfiles()).toEqual({
      defaultProfileId: null,
      profiles: [{ id: "git-bash", label: "Git Bash" }],
    });
    expect(host.spawn({ cols: 80, profileId: "git-bash", rows: 24 })).toMatchObject({ profileId: "git-bash" });
    expect(calls[0]?.slice(0, 2)).toEqual([gitBash, ["--login", "-i"]]);
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
