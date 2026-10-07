import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import type { LocalAgentJsonValue } from "./protocol.js";
import type { LocalAgentProcess } from "./runtime-manager.js";

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

export function buildLocalAgentProviderConfig(relayPort: number): string {
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65_535) {
    throw new RangeError("local model relay port is invalid");
  }
  return [
    'model_provider = "ardor"',
    "",
    "[model_providers.ardor]",
    'name = "Ardor"',
    `base_url = "http://127.0.0.1:${relayPort}/v1"`,
    'wire_api = "responses"',
    'env_key = "ARDOR_DESKTOP_RELAY_TOKEN"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  ].join("\n");
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
  const child = spawn(options.command, [...options.args], {
    cwd: resolve(options.cwd),
    env: options.env,
    detached: options.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new LocalAgentStdioProcess(child, options.platform, stopTimeoutMs);
}

class LocalAgentStdioProcess extends EventEmitter implements LocalAgentProcess {
  private buffer = Buffer.alloc(0);
  private exitCode: number | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly platform: NodeJS.Platform,
    private readonly stopTimeoutMs: number,
  ) {
    super();
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk));
    child.once("error", () => this.finish(-1));
    child.once("exit", (code) => this.finish(code ?? -1));
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

  private async stopProcess(): Promise<void> {
    if (this.exitCode !== null) return;
    const exited = new Promise<void>((resolveExit) => {
      this.once("exit", () => resolveExit());
    });
    this.child.stdin.end();
    if (await promiseSettledWithin(exited, this.stopTimeoutMs)) return;
    await terminateProcessTree(this.child, this.platform);
    await promiseSettledWithin(exited, 2_000);
  }

  private readStdout(chunk: Buffer): void {
    if (this.exitCode !== null) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.byteLength > MAX_RPC_LINE_BYTES && !this.buffer.includes(10)) {
      void terminateProcessTree(this.child, this.platform);
      this.finish(-1);
      return;
    }
    while (this.exitCode === null) {
      const newlineIndex = this.buffer.indexOf(10);
      if (newlineIndex < 0) return;
      if (newlineIndex > MAX_RPC_LINE_BYTES) {
        void terminateProcessTree(this.child, this.platform);
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
        void terminateProcessTree(this.child, this.platform);
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
  const didSettle = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return didSettle;
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams, platform: NodeJS.Platform): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await Promise.race([
      new Promise<void>((resolveExit) => taskkill.once("exit", () => resolveExit())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
    if (child.exitCode === null) child.kill();
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000));
  if (child.exitCode === null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
