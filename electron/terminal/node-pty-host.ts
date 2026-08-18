import { statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import * as nodePty from "node-pty";

import type { PtyHost, PtyProcess, PtySpawnRequest, PtySpawnResult } from "./pty-host.js";
import { PtyHostError } from "./pty-host.js";
import type {
  TerminalShellProfile,
  TerminalShellProfileCatalog,
  TerminalShellProfileId,
} from "./shell-profile.js";

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
  isFile?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  probeWsl?: (executable: string) => boolean;
  spawnPty?: NodePtySpawnAdapter;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function probeWsl(executable: string): boolean {
  const result = spawnSync(executable, ["--list", "--quiet"], {
    encoding: "utf8",
    timeout: 750,
    windowsHide: true,
  });
  return result.status === 0 && (result.stdout ?? "").replaceAll("\u0000", "").trim().length > 0;
}

interface ResolvedShellProfile extends TerminalShellProfile {
  readonly args: readonly string[];
  readonly executable: string;
}

const spawnNodePty: NodePtySpawnAdapter = (file, args, options) => {
  return nodePty.spawn(file, args, options);
};

export class NodePtyHost implements PtyHost {
  private readonly defaultCwd: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private readonly isDirectory: (path: string) => boolean;
  private readonly isFile: (path: string) => boolean;
  private readonly path: typeof posix;
  private readonly platform: NodeJS.Platform;
  private readonly probeWsl: (executable: string) => boolean;
  private readonly spawnPty: NodePtySpawnAdapter;
  private shellProfiles: readonly ResolvedShellProfile[] | null = null;

  constructor(options: NodePtyHostOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.path = this.platform === "win32" ? win32 : posix;
    this.environment = options.environment ?? process.env;
    this.isDirectory = options.isDirectory ?? isDirectory;
    this.isFile = options.isFile ?? isFile;
    this.probeWsl = options.probeWsl ?? probeWsl;
    this.spawnPty = options.spawnPty ?? spawnNodePty;
    this.defaultCwd = this.firstSafeDirectory(
      options.homeDirectory ?? homedir(),
      options.currentDirectory ?? process.cwd(),
    );
  }

  listProfiles(): TerminalShellProfileCatalog {
    const profiles = this.resolveShellProfiles();
    return {
      defaultProfileId: this.defaultProfileId(profiles),
      profiles: profiles.map(({ id, label }) => ({ id, label })),
    };
  }

  spawn(request: PtySpawnRequest): PtySpawnResult {
    const cwd = request.cwd === undefined ? this.defaultCwd : this.resolveDirectory(request.cwd);
    const profiles = this.resolveShellProfiles();
    const profileId = request.profileId ?? this.defaultProfileId(profiles);
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) throw new PtyHostError("SHELL_UNAVAILABLE");
    try {
      const pty = this.spawnPty(profile.executable, [...profile.args], {
        cols: request.cols,
        cwd,
        env: this.createChildEnvironment(),
        name: "xterm-256color",
        rows: request.rows,
      });
      return { cwd, profileId: profile.id, pty, shell: this.path.basename(profile.executable) };
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

  private defaultProfileId(profiles: readonly ResolvedShellProfile[]): TerminalShellProfileId | null {
    if (this.platform !== "win32") return profiles[0]?.id ?? null;
    for (const id of ["wsl-default", "pwsh", "windows-powershell", "cmd"] as const) {
      if (profiles.some((profile) => profile.id === id)) return id;
    }
    return null;
  }

  private resolveShellProfiles(): readonly ResolvedShellProfile[] {
    if (this.shellProfiles) return this.shellProfiles;
    if (this.platform !== "win32") {
      const executable = this.resolveUnixShell();
      this.shellProfiles = [{ args: ["-l"], executable, id: "system", label: this.path.basename(executable) }];
      return this.shellProfiles;
    }

    const systemRoot = this.safeWindowsBaseDirectory(this.environment.SystemRoot, "C:\\Windows");
    const programFiles = this.safeWindowsBaseDirectory(
      this.environment.ProgramW6432 ?? this.environment.ProgramFiles,
      "C:\\Program Files",
    );
    const localAppData = this.optionalWindowsBaseDirectory(this.environment.LOCALAPPDATA);
    const candidates: readonly ResolvedShellProfile[] = [
      {
        args: ["--cd", "~"],
        executable: this.path.join(systemRoot, "System32", "wsl.exe"),
        id: "wsl-default",
        label: "WSL (default)",
      },
      {
        args: ["-NoLogo"],
        executable: this.path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
        id: "pwsh",
        label: "PowerShell 7",
      },
      {
        args: ["-NoLogo"],
        executable: this.path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        id: "windows-powershell",
        label: "Windows PowerShell",
      },
      {
        args: ["--login", "-i"],
        executable: this.path.join(programFiles, "Git", "bin", "bash.exe"),
        id: "git-bash",
        label: "Git Bash",
      },
      ...(localAppData ? [{
        args: ["--login", "-i"] as const,
        executable: this.path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
        id: "git-bash" as const,
        label: "Git Bash",
      }] : []),
      {
        args: [],
        executable: this.path.join(systemRoot, "System32", "cmd.exe"),
        id: "cmd",
        label: "Command Prompt",
      },
    ];
    const seen = new Set<TerminalShellProfileId>();
    this.shellProfiles = candidates.filter((profile) => {
      if (seen.has(profile.id) || !this.isFile(profile.executable)) return false;
      if (profile.id === "wsl-default" && !this.probeWsl(profile.executable)) return false;
      seen.add(profile.id);
      return true;
    });
    return this.shellProfiles;
  }

  private safeWindowsBaseDirectory(value: string | undefined, fallback: string): string {
    return value && this.path.isAbsolute(value) ? this.path.resolve(value) : fallback;
  }

  private optionalWindowsBaseDirectory(value: string | undefined): string | null {
    return value && this.path.isAbsolute(value) ? this.path.resolve(value) : null;
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
