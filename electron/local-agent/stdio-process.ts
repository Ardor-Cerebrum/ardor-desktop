import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve, win32 } from "node:path";

import type { LocalAgentJsonValue } from "./protocol.js";
import type { LocalAgentProcess } from "./runtime-manager.js";
import { spawnWindowsJobProcess } from "./windows-job-process.js";

const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;
const SAFE_PROCESS_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "COMSPEC",
  "PATHEXT",
  "OS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export interface LocalAgentStdioProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly stopTimeoutMs?: number;
}

export function buildLocalAgentProviderConfig(relayPort: number, platform: NodeJS.Platform = process.platform, runtimeCatalogPath?: string): string {
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65_535) {
    throw new RangeError("local model relay port is invalid");
  }
  const lines = [
    'default_permissions = "ardor-local-workspace"',
    "",
    'model_provider = "ardor"',
    ...(runtimeCatalogPath ? [`model_catalog_json = ${JSON.stringify(runtimeCatalogPath)}`] : []),
    "",
    "[model_providers.ardor]",
    'name = "Ardor"',
    `base_url = "http://127.0.0.1:${relayPort}/v1"`,
    'wire_api = "responses"',
    'env_key = "ARDOR_DESKTOP_RELAY_TOKEN"',
    "requires_openai_auth = false",
    "supports_websockets = false",
  ];
  if (runtimeCatalogPath !== undefined &&
      (!(platform === "win32" ? win32.isAbsolute(runtimeCatalogPath) : isAbsolute(runtimeCatalogPath)) || /[\u0000-\u001f]/.test(runtimeCatalogPath))) {
    throw new TypeError("Runtime model catalog path must be absolute.");
  }
  if (platform === "win32") {
    lines.push("", "[windows]", 'sandbox = "mxc"');
  }
  lines.push(
    "",
    "[permissions.ardor-local-workspace]",
    'extends = ":workspace"',
    "",
    "[permissions.ardor-local-workspace.filesystem]",
    '":tmpdir" = "read"',
    '":slash_tmp" = "read"',
    "",
    "[permissions.ardor-local-workspace.network]",
    "enabled = false",
  );
  return `${lines.join("\n")}\n`;
}

export function buildLocalAgentArguments(args: readonly string[], platform: NodeJS.Platform): string[] {
  // SECURITY(ARD-2319): project config must not replace the selected Windows
  // backend. Explicit MXC fails closed; prefer_mxc alone permits legacy fallback.
  return platform === "win32" ? [...args, "-c", 'windows.sandbox="mxc"'] : [...args];
}

export function buildLocalAgentEnvironment(
  source: NodeJS.ProcessEnv,
  runtimeHome: string,
  relayToken: string,
): NodeJS.ProcessEnv {
  const normalizedEnvironment = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) normalizedEnvironment.set(key.toUpperCase(), value);
  }

  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PROCESS_ENVIRONMENT) {
    const value = normalizedEnvironment.get(key);
    if (value !== undefined) environment[key] = value;
  }
  environment.CODEX_HOME = runtimeHome;
  environment.ARDOR_DESKTOP_RELAY_TOKEN = relayToken;
  return environment;
}

export function createLocalAgentStdioProcess(options: LocalAgentStdioProcessOptions): LocalAgentProcess {
  if (!isAbsolute(options.command) || !isAbsolute(options.cwd)) {
    throw new TypeError("Local Cerebrum executable and working directory must be absolute.");
  }
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  if (stopTimeoutMs < 1) throw new RangeError("Local Cerebrum stop timeout must be positive.");
  if (options.platform === "win32") {
    const { child, terminate, decodeExitCode } = spawnWindowsJobProcess(options);
    return new LocalAgentStdioProcess(child, terminate, stopTimeoutMs, decodeExitCode);
  }
  const child = spawn(options.command, [...options.args], {
    cwd: resolve(options.cwd),
    env: options.env,
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new LocalAgentStdioProcess(child, () => terminateProcessGroup(child), stopTimeoutMs);
}

class LocalAgentStdioProcess extends EventEmitter implements LocalAgentProcess {
  private buffer = Buffer.alloc(0);
  private exitCode: number | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly terminateTree: () => Promise<void>,
    private readonly stopTimeoutMs: number,
    private readonly decodeExitCode: (code: number | null) => number = (code) => code ?? -1,
  ) {
    super();
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk));
    child.stdin.on("error", () => {
      void this.stopImmediately().catch(() => undefined);
      this.finish(-1);
    });
    child.once("error", () => this.finish(-1));
    child.once("exit", (code) => {
      this.finish(this.decodeExitCode(code));
      // Reap remaining group members promptly, not on a later reused numeric PID.
      void this.stopImmediately().catch(() => undefined);
    });
  }

  send(message: Record<string, LocalAgentJsonValue>): void {
    if (this.exitCode !== null || this.child.stdin.destroyed) {
      throw new Error("Local Cerebrum process is closed.");
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_RPC_LINE_BYTES) {
      throw new RangeError("Local Cerebrum RPC request is too large.");
    }
    this.child.stdin.write(line, "utf8");
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopProcess();
    return this.stopPromise;
  }

  private stopImmediately(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.terminateAndCloseStreams();
    return this.stopPromise;
  }

  private async stopProcess(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => {
        this.child.once("exit", () => resolveExit());
      });
      this.child.stdin.end();
      await promiseSettledWithin(exited, this.stopTimeoutMs);
    }
    // SECURITY(ARD-2909): on POSIX, parent exit is not evidence of group exit.
    await this.terminateAndCloseStreams();
  }

  private async terminateAndCloseStreams(): Promise<void> {
    try {
      await this.terminateTree();
    } finally {
      // Authority is revoked even when OS cleanup cannot be confirmed. Do not
      // keep transport handles alive after shutdown or a failed startup.
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
  }

  private readStdout(chunk: Buffer): void {
    if (this.exitCode !== null) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_RPC_LINE_BYTES && !this.buffer.includes(10)) {
      void this.stopImmediately().catch(() => undefined);
      this.finish(-1);
      return;
    }
    while (this.exitCode === null) {
      const newlineIndex = this.buffer.indexOf(10);
      if (newlineIndex < 0) return;
      if (newlineIndex > MAX_RPC_LINE_BYTES) {
        void this.stopImmediately().catch(() => undefined);
        this.finish(-1);
        return;
      }
      const line = this.buffer.subarray(0, newlineIndex).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        void this.stopImmediately().catch(() => undefined);
        this.finish(-1);
        return;
      }
      this.emit("message", message);
    }
  }

  private finish(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.buffer = Buffer.alloc(0);
    this.emit("exit", code);
  }
}

async function promiseSettledWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function terminateProcessGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid local runtime process ID.");
  if (!signalProcessGroup(pid, "SIGTERM")) return;
  if (await waitForProcessGroupExit(pid, 1_000)) return;
  // The leader may have exited while a descendant ignored SIGTERM.
  if (!signalProcessGroup(pid, "SIGKILL")) return;
  if (!await waitForProcessGroupExit(pid, 2_000)) {
    throw new Error("Local Cerebrum process group did not terminate.");
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (signalProcessGroup(pid, 0)) {
    if (performance.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return true;
}
