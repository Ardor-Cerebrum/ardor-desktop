import { TerminalBrokerManager } from "./broker-manager.js";
import { isTerminalBrokerRequest, TERMINAL_BROKER_PROTOCOL_VERSION } from "./protocol.js";
import type { PtyHost } from "./pty-host.js";

export interface TerminalBrokerPort {
  off(event: "message", listener: (event: { data: unknown }) => void): this;
  on(event: "message", listener: (event: { data: unknown }) => void): this;
  postMessage(message: unknown): void;
}

export interface TerminalBrokerEndpointOptions {
  readonly brokerId: string;
  readonly host: PtyHost;
  readonly onShutdown?: () => void;
  readonly port: TerminalBrokerPort;
}

export class TerminalBrokerEndpoint {
  private readonly brokerId: string;
  private disposed = false;
  private readonly manager: TerminalBrokerManager;
  private readonly onMessage: (event: { data: unknown }) => void;
  private readonly onShutdown: () => void;
  private readonly port: TerminalBrokerPort;

  constructor(options: TerminalBrokerEndpointOptions) {
    this.brokerId = options.brokerId;
    this.port = options.port;
    this.onShutdown = options.onShutdown ?? (() => undefined);
    this.manager = new TerminalBrokerManager({
      brokerId: options.brokerId,
      host: options.host,
      onEvent: (message) => this.port.postMessage(message),
    });
    this.onMessage = (event) => this.handleMessage(event.data);
  }

  start(): void {
    if (this.disposed) throw new Error("terminal broker endpoint is disposed");
    this.port.on("message", this.onMessage);
    this.port.postMessage({
      brokerId: this.brokerId,
      protocolVersion: TERMINAL_BROKER_PROTOCOL_VERSION,
      type: "ready",
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.off("message", this.onMessage);
    this.manager.dispose();
  }

  private handleMessage(value: unknown): void {
    if (this.disposed || !isTerminalBrokerRequest(value)) return;
    const response = this.manager.handle(value);
    this.port.postMessage(response);
    if (value.type === "shutdown") {
      this.dispose();
      this.onShutdown();
    }
  }
}
