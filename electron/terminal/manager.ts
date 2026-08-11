import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

import { spawn, type IPty } from "node-pty";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_SCROLLBACK_BYTES = 256 * 1024;
const OUTPUT_BATCH_MS = 16;

export interface TerminalOpenRequest {
  cols?: number;
  cwd?: string;
  rows?: number;
}

export interface TerminalSnapshot {
  buffer: string;
  cols: number;
  cwd: string;
  exitCode: number | null;
  generation: number;
  rows: number;
  sequence: number;
  shell: string;
  status: "exited" | "running";
  terminalId: string;
}

export type TerminalEvent =
  | {
      data: string;
      generation: number;
      sequence: number;
      terminalId: string;
      type: "data";
    }
  | {
      exitCode: number | null;
      generation: number;
      sequence: number;
      terminalId: string;
      type: "exit";
    };

interface TerminalPty {
  readonly pid: number;
  kill(signal?: string): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  write(data: string): void;
}

interface TerminalSession {
  buffer: string;
  cols: number;
  cwd: string;
  exitCode: number | null;
  generation: number;
  ownerId: number;
  pendingData: string[];
  pendingTimer: ReturnType<typeof setTimeout> | null;
  pty: TerminalPty | null;
  rows: number;
  sequence: number;
  shell: string;
  terminalId: string;
}

type SpawnTerminal = (
  file: string,
  args: string[],
  options: {
    cols: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
    name: string;
    rows: number;
  },
) => TerminalPty;

export interface TerminalManagerOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  onEvent: (ownerId: number, event: TerminalEvent) => void;
  platform?: NodeJS.Platform;
  spawnTerminal?: SpawnTerminal;
}

export class TerminalManager {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly generations = new Map<string, number>();
  private readonly homeDirectory: string;
  private readonly onEvent: TerminalManagerOptions["onEvent"];
  private readonly platform: NodeJS.Platform;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly spawnTerminal: SpawnTerminal;

  constructor(options: TerminalManagerOptions) {
    this.environment = options.environment ?? process.env;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.onEvent = options.onEvent;
    this.platform = options.platform ?? process.platform;
    this.spawnTerminal = options.spawnTerminal ?? ((file, args, spawnOptions) => spawn(file, args, spawnOptions) as IPty);
  }

  open(ownerId: number, terminalId: string, request: TerminalOpenRequest = {}): TerminalSnapshot {
    const existing = this.sessions.get(terminalId);
    if (existing) {
      this.assertOwner(existing, ownerId);
      this.flush(existing);
      return this.snapshot(existing);
    }

    const cols = normalizeDimension(request.cols, DEFAULT_COLS);
    const rows = normalizeDimension(request.rows, DEFAULT_ROWS);
    const cwd = this.resolveCwd(request.cwd);
    const [shell, args] = resolveTerminalCommand(this.platform, this.environment);
    const generation = (this.generations.get(terminalId) ?? 0) + 1;
    this.generations.set(terminalId, generation);

    const pty = this.spawnTerminal(shell, args, {
      cols,
      cwd,
      env: buildTerminalEnvironment(this.environment),
      name: "xterm-256color",
      rows,
    });
    const session: TerminalSession = {
      buffer: "",
      cols,
      cwd,
      exitCode: null,
      generation,
      ownerId,
      pendingData: [],
      pendingTimer: null,
      pty,
      rows,
      sequence: 0,
      shell: shell.split(/[\\/]/).at(-1) || shell,
      terminalId,
    };
    this.sessions.set(terminalId, session);

    pty.onData((data) => this.handleData(session, data));
    pty.onExit(({ exitCode }) => this.handleExit(session, exitCode));
    return this.snapshot(session);
  }

  restart(ownerId: number, terminalId: string, request: TerminalOpenRequest = {}): TerminalSnapshot {
    this.close(ownerId, terminalId);
    return this.open(ownerId, terminalId, request);
  }

  write(ownerId: number, terminalId: string, data: string): boolean {
    const session = this.requireSession(ownerId, terminalId);
    if (!session.pty) return false;
    session.pty.write(data);
    return true;
  }

  resize(ownerId: number, terminalId: string, cols: number, rows: number): boolean {
    const session = this.requireSession(ownerId, terminalId);
    if (!session.pty) return false;
    const nextCols = normalizeDimension(cols, session.cols);
    const nextRows = normalizeDimension(rows, session.rows);
    if (nextCols === session.cols && nextRows === session.rows) return true;
    session.cols = nextCols;
    session.rows = nextRows;
    session.pty.resize(nextCols, nextRows);
    return true;
  }

  close(ownerId: number, terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    this.assertOwner(session, ownerId);
    this.sessions.delete(terminalId);
    this.flush(session);
    session.pendingTimer && clearTimeout(session.pendingTimer);
    session.pendingTimer = null;
    try {
      session.pty?.kill();
    } catch {
      // The process may have already exited between the lookup and the close.
    }
    session.pty = null;
    return true;
  }

  closeOwner(ownerId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId) this.close(ownerId, session.terminalId);
    }
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) this.close(session.ownerId, session.terminalId);
  }

  private handleData(session: TerminalSession, data: string): void {
    if (this.sessions.get(session.terminalId) !== session || !data) return;
    session.buffer = `${session.buffer}${data}`.slice(-MAX_SCROLLBACK_BYTES);
    session.pendingData.push(data);
    session.pendingTimer ??= setTimeout(() => this.flush(session), OUTPUT_BATCH_MS);
  }

  private handleExit(session: TerminalSession, exitCode: number): void {
    if (this.sessions.get(session.terminalId) !== session) return;
    this.flush(session);
    session.pty = null;
    session.exitCode = exitCode;
    session.sequence += 1;
    this.onEvent(session.ownerId, {
      exitCode,
      generation: session.generation,
      sequence: session.sequence,
      terminalId: session.terminalId,
      type: "exit",
    });
  }

  private flush(session: TerminalSession): void {
    session.pendingTimer && clearTimeout(session.pendingTimer);
    session.pendingTimer = null;
    if (session.pendingData.length === 0 || this.sessions.get(session.terminalId) !== session) return;
    const data = session.pendingData.join("");
    session.pendingData = [];
    session.sequence += 1;
    this.onEvent(session.ownerId, {
      data,
      generation: session.generation,
      sequence: session.sequence,
      terminalId: session.terminalId,
      type: "data",
    });
  }

  private requireSession(ownerId: number, terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error("terminal session is unavailable");
    this.assertOwner(session, ownerId);
    return session;
  }

  private assertOwner(session: TerminalSession, ownerId: number): void {
    if (session.ownerId !== ownerId) throw new Error("terminal session belongs to another window");
  }

  private resolveCwd(requested: string | undefined): string {
    if (requested && isAbsolute(requested) && existsSync(requested)) return requested;
    if (existsSync(this.homeDirectory)) return this.homeDirectory;
    return process.cwd();
  }

  private snapshot(session: TerminalSession): TerminalSnapshot {
    return {
      buffer: session.buffer,
      cols: session.cols,
      cwd: session.cwd,
      exitCode: session.exitCode,
      generation: session.generation,
      rows: session.rows,
      sequence: session.sequence,
      shell: session.shell,
      status: session.pty ? "running" : "exited",
      terminalId: session.terminalId,
    };
  }
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 2 && value <= 500 ? value : fallback;
}

function resolveTerminalCommand(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): [string, string[]] {
  if (platform === "win32") return [environment.COMSPEC || "cmd.exe", []];
  const configured = environment.SHELL;
  const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return [configured && isAbsolute(configured) && existsSync(configured) ? configured : fallback, ["-l"]];
}

function buildTerminalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.ELECTRON_RUN_AS_NODE;
  result.COLORTERM = "truecolor";
  result.TERM = "xterm-256color";
  result.TERM_PROGRAM = "Ardor";
  return result;
}
