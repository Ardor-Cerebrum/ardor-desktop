import { accessSync, constants, statSync } from "node:fs";
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
  isExecutableFile?: (path: string) => boolean;
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

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
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
  private readonly isExecutableFile: (path: string) => boolean;
  private readonly path: typeof posix;
  private readonly platform: NodeJS.Platform;
  private readonly spawnPty: NodePtySpawnAdapter;

  constructor(options: NodePtyHostOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.path = this.platform === "win32" ? win32 : posix;
    this.environment = options.environment ?? process.env;
    this.isDirectory = options.isDirectory ?? isDirectory;
    this.isExecutableFile = options.isExecutableFile ?? isExecutableFile;
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
      const configured = this.environment.COMSPEC;
      const shell = configured
        && this.path.isAbsolute(configured)
        && this.isExecutableFile(configured)
        ? configured
        : "cmd.exe";
      return [shell, []];
    }

    const configured = this.environment.SHELL;
    if (
      configured
      && this.path.isAbsolute(configured)
      && this.isExecutableFile(configured)
    ) {
      return [configured, ["-l"]];
    }
    return [this.platform === "darwin" ? "/bin/zsh" : "/bin/bash", ["-l"]];
  }
}
