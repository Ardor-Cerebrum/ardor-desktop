import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export const CEREBRUM_CLIENT_METHODS = [
  "account/login/start",
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "turn/start",
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
};

export interface CerebrumAppServerClientOptions {
  binaryPath: string;
  onMessage(message: CerebrumServerMessage): void;
  version: string;
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
      this.#startPromise = this.#start();
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
      ["--profile", "ardor-desktop", "app-server", "--stdio"],
      { env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.#process = child;
    child.once("error", (cause) => {
      this.#startPromise = undefined;
      this.#rejectPending(cause);
    });
    child.once("exit", (code, signal) => {
      this.#process = undefined;
      this.#startPromise = undefined;
      this.#rejectPending(
        new Error(`Cerebrum app-server exited (${code ?? signal ?? "unknown"})`),
      );
    });
    child.stderr.on("data", (chunk: Buffer) => {
      console.warn(`[cerebrum] ${chunk.toString("utf8").trimEnd()}`);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));

    await new Promise<void>((resolveStart, rejectStart) => {
      child.once("spawn", resolveStart);
      child.once("error", rejectStart);
    });
    await this.#sendRequest("initialize", {
      clientInfo: {
        name: "ardor-desktop",
        title: "Ardor Desktop",
        version: this.#options.version,
      },
      capabilities: { experimentalApi: true },
    });
    this.#write({ method: "initialized", params: {} });
  }

  #sendRequest(method: string, params: JsonObject): Promise<unknown> {
    const id = this.#nextRequestId++;
    return new Promise((resolveRequest, rejectRequest) => {
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      try {
        this.#write({ id, method, params });
      } catch (cause) {
        this.#pending.delete(id);
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
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonObject;
        pending.reject(new Error(String(error.message ?? "Cerebrum request failed")));
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
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
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
