import { statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import * as nodePty from "node-pty";

import type { PtyHost, PtyProcess, PtySpawnRequest, PtySpawnResult } from "./pty-host.js";
import { PtyHostError } from "./pty-host.js";

interface NodePtySpawnOptions {
  cols: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  name: "xterm-256color";
  rows: number;
}

export type NodePtySpawnAdapter = (
  file: string,
  args: string[],
  options: NodePtySpawnOptions,
) => PtyProcess;

export interface NodePtyHostOptions {
  currentDirectory?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  homeDirectory?: string;
  isDirectory?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  spawnPty?: NodePtySpawnAdapter;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const spawnNodePty: NodePtySpawnAdapter = (file, args, options) => {
  return nodePty.spawn(file, args, options);
};

export class NodePtyHost implements PtyHost {
  private readonly defaultCwd: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly isDirectory: (path: string) => boolean;
  private readonly path: typeof posix;
  private readonly platform: NodeJS.Platform;
  private readonly spawnPty: NodePtySpawnAdapter;

  constructor(options: NodePtyHostOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.path = this.platform === "win32" ? win32 : posix;
    this.environment = options.environment ?? process.env;
    this.isDirectory = options.isDirectory ?? isDirectory;
    this.spawnPty = options.spawnPty ?? spawnNodePty;
    this.defaultCwd = this.firstSafeDirectory(
      options.homeDirectory ?? homedir(),
      options.currentDirectory ?? process.cwd(),
    );
  }

  spawn(request: PtySpawnRequest): PtySpawnResult {
    const cwd = request.cwd === undefined ? this.defaultCwd : this.resolveDirectory(request.cwd);
    const [shell, args] = this.resolveShellCommand();
    try {
      const pty = this.spawnPty(shell, args, {
        cols: request.cols,
        cwd,
        env: this.createChildEnvironment(),
        name: "xterm-256color",
        rows: request.rows,
      });
      return { cwd, pty, shell: this.path.basename(shell) };
    } catch (cause) {
      throw new PtyHostError("SPAWN_FAILED", { cause });
    }
  }

  private createChildEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...this.environment };
    delete environment.ELECTRON_RUN_AS_NODE;
    environment.COLORTERM = "truecolor";
    environment.TERM = "xterm-256color";
    environment.TERM_PROGRAM = "Ardor";
    return environment;
  }

  private firstSafeDirectory(...candidates: string[]): string {
    for (const candidate of candidates) {
      if (!candidate || !this.path.isAbsolute(candidate)) continue;
      const resolved = this.path.resolve(candidate);
      if (this.isDirectory(resolved)) return resolved;
    }
    throw new PtyHostError("INVALID_CWD");
  }

  private resolveDirectory(path: string): string {
    if (!path || !this.path.isAbsolute(path)) throw new PtyHostError("INVALID_CWD");
    const resolved = this.path.resolve(path);
    if (!this.isDirectory(resolved)) throw new PtyHostError("INVALID_CWD");
    return resolved;
  }

  private resolveShellCommand(): readonly [string, string[]] {
    if (this.platform === "win32") {
      return ["cmd.exe", []];
    }

    return [this.resolveUnixShell(), ["-l"]];
  }

  private resolveUnixShell(): string {
    switch (this.environment.SHELL) {
      case "/bin/bash": return "/bin/bash";
      case "/bin/fish": return "/bin/fish";
      case "/bin/zsh": return "/bin/zsh";
      case "/opt/homebrew/bin/bash": return "/opt/homebrew/bin/bash";
      case "/opt/homebrew/bin/fish": return "/opt/homebrew/bin/fish";
      case "/opt/homebrew/bin/zsh": return "/opt/homebrew/bin/zsh";
      case "/usr/bin/bash": return "/usr/bin/bash";
      case "/usr/bin/fish": return "/usr/bin/fish";
      case "/usr/bin/zsh": return "/usr/bin/zsh";
      case "/usr/local/bin/bash": return "/usr/local/bin/bash";
      case "/usr/local/bin/fish": return "/usr/local/bin/fish";
      case "/usr/local/bin/zsh": return "/usr/local/bin/zsh";
      default: return this.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
    }
  }
}
