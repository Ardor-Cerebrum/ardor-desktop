export interface PtyDisposable {
  dispose(): void;
}

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtyProcess {
  readonly pid: number;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
  pause(): void;
  resize(cols: number, rows: number): void;
  resume(): void;
  write(data: string): void;
}

export interface PtySpawnRequest {
  cols: number;
  cwd?: string;
  rows: number;
}

export interface PtySpawnResult {
  cwd: string;
  pty: PtyProcess;
  shell: string;
}

export interface PtyHost {
  spawn(request: PtySpawnRequest): PtySpawnResult;
}

export type PtyHostErrorCode = "INVALID_CWD" | "SPAWN_FAILED";

const ERROR_MESSAGES: Record<PtyHostErrorCode, string> = {
  INVALID_CWD: "Terminal working directory is invalid.",
  SPAWN_FAILED: "Terminal process could not be started.",
};

export class PtyHostError extends Error {
  readonly code: PtyHostErrorCode;

  constructor(code: PtyHostErrorCode, options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options);
    this.name = "PtyHostError";
    this.code = code;
  }
}
