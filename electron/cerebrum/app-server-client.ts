import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export const CEREBRUM_CLIENT_METHODS = [
  "account/login/start",
  "account/logout",
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/start",
  "thread/resume",
  "model/list",
  "configRequirements/read",
  "permissionProfile/list",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

export type CerebrumClientMethod = (typeof CEREBRUM_CLIENT_METHODS)[number];
export type JsonObject = Record<string, unknown>;
export type CerebrumServerMessage = {
  id?: number | string;
  method: string;
  params?: JsonObject;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface CerebrumAppServerClientOptions {
  binaryPath: string;
  onMessage(message: CerebrumServerMessage): void;
  version: string;
  requestTimeoutMs?: number;
}

export class CerebrumRequestError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "CerebrumRequestError";
    this.code = code;
    this.data = data;
  }
}

export class CerebrumAppServerClient {
  readonly #options: CerebrumAppServerClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #process?: ChildProcessWithoutNullStreams;
  #startPromise?: Promise<void>;

  constructor(options: CerebrumAppServerClientOptions) {
    this.#options = options;
  }

  async request(method: CerebrumClientMethod, params: JsonObject = {}): Promise<unknown> {
    await this.start();
    return this.#sendRequest(method, params);
  }

  async respond(id: number | string, result: unknown): Promise<void> {
    await this.start();
    this.#write({ id, result });
  }

  start(): Promise<void> {
    if (!this.#startPromise) {
      const startPromise = this.#start();
      this.#startPromise = startPromise;
      startPromise.catch(() => {
        if (this.#startPromise === startPromise) this.#startPromise = undefined;
      });
    }
    return this.#startPromise;
  }

  stop(): void {
    const child = this.#process;
    this.#process = undefined;
    this.#startPromise = undefined;
    child?.kill();
    this.#rejectPending(new Error("Cerebrum app-server stopped"));
  }

  async #start(): Promise<void> {
    const child = spawn(
      this.#options.binaryPath,
      ["--profile", "ardor-desktop", "desktop-runtime", "--stdio"],
      { env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.#process = child;
    child.once("error", (cause) => {
      this.#handleTermination(child, cause);
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`Cerebrum desktop runtime exited (${code ?? signal ?? "unknown"})`);
      this.#handleTermination(child, error);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      console.warn(`[cerebrum] ${chunk.toString("utf8").trimEnd()}`);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));

    await new Promise<void>((resolveStart, rejectStart) => {
      child.once("spawn", resolveStart);
      child.once("error", rejectStart);
    });
    try {
      await this.#sendRequest("initialize", {
        clientInfo: {
          name: "ardor-desktop",
          title: "Ardor Desktop",
          version: this.#options.version,
        },
        capabilities: { experimentalApi: true },
      });
      this.#write({ method: "initialized", params: {} });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#handleTermination(child, error);
      child.kill();
      throw error;
    }
  }

  #sendRequest(method: string, params: JsonObject): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        rejectRequest(new Error(`Cerebrum request timed out: ${method}`));
      }, this.#options.requestTimeoutMs ?? 30_000);
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      try {
        this.#write({ id, method, params });
      } catch (cause) {
        this.#pending.delete(id);
        clearTimeout(timeout);
        rejectRequest(cause);
      }
    });
  }

  #write(message: JsonObject): void {
    const child = this.#process;
    if (!child?.stdin.writable) {
      throw new Error("Cerebrum app-server is unavailable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      console.warn("Cerebrum app-server emitted invalid JSON");
      return;
    }
    const id = message.id;
    if ((typeof id === "number" || typeof id === "string") && !message.method) {
      const pending = typeof id === "number" ? this.#pending.get(id) : undefined;
      if (!pending) return;
      this.#pending.delete(id as number);
      clearTimeout(pending.timeout);
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonObject;
        pending.reject(
          new CerebrumRequestError(
            String(error.message ?? "Cerebrum request failed"),
            typeof error.code === "number" ? error.code : undefined,
            error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.#options.onMessage(message as CerebrumServerMessage);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #handleTermination(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#process !== child) return;
    this.#process = undefined;
    this.#startPromise = undefined;
    this.#rejectPending(error);
    this.#options.onMessage({ method: "desktop/runtime/fatal", params: { message: error.message, recoverable: true } });
  }
}

export function resolveCerebrumBinary({
  appPath,
  isPackaged,
  resourcesPath,
  platform = process.platform,
}: {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
}): string {
  const executable = platform === "win32" ? "cerebrum.exe" : "cerebrum";
  const candidates = isPackaged
    ? [resolve(resourcesPath, "cerebrum", executable)]
    : [
        resolve(appPath, "..", "codex", "cerebrum-rs", "target", "release", executable),
        resolve(appPath, "..", "codex", "cerebrum-rs", "target", "debug", executable),
      ];
  const found = candidates.find(existsSync);
  if (!found) {
    throw new Error(`Cerebrum binary is unavailable; checked ${candidates.join(", ")}`);
  }
  return realpathSync(found);
}
