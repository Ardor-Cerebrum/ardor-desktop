import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";

import { TerminalBrokerEndpoint } from "./broker-endpoint.js";
import type { PtyHost, PtyProcess, PtySpawnRequest } from "./pty-host.js";

class FakePort extends EventEmitter {
  readonly sent: unknown[] = [];
  postMessage(message: unknown): void { this.sent.push(message); }
  receive(data: unknown): void { this.emit("message", { data }); }
}

class FakePty implements PtyProcess {
  readonly pid = 1;
  kill(): void {}
  onData(): { dispose(): void } { return { dispose: () => undefined }; }
  onExit(): { dispose(): void } { return { dispose: () => undefined }; }
  pause(): void {}
  resize(): void {}
  resume(): void {}
  write(): void {}
}

class FakeHost implements PtyHost {
  listProfiles() {
    return { defaultProfileId: "system" as const, profiles: [{ id: "system" as const, label: "zsh" }] };
  }
  spawn(request: PtySpawnRequest) {
    return { cwd: request.cwd ?? "/home", profileId: "system" as const, pty: new FakePty(), shell: "zsh" };
  }
}

describe("TerminalBrokerEndpoint", () => {
  test("announces readiness, ignores malformed input, handles requests, and shuts down cleanly", () => {
    const port = new FakePort();
    let shutdowns = 0;
    const endpoint = new TerminalBrokerEndpoint({
      brokerId: "broker:one",
      host: new FakeHost(),
      onShutdown: () => { shutdowns += 1; },
      port,
    });
    endpoint.start();
    expect(port.sent).toEqual([{ brokerId: "broker:one", protocolVersion: 1, type: "ready" }]);

    port.receive({ secret: "not a request" });
    expect(port.sent).toHaveLength(1);
    port.receive({
      brokerId: "broker:one",
      cols: 80,
      ownerId: 7,
      protocolVersion: 1,
      requestId: "open",
      rows: 24,
      terminalId: "terminal:one",
      type: "open",
    });
    expect(port.sent.at(-1)).toMatchObject({ ok: true, requestId: "open", requestType: "open" });

    port.receive({
      brokerId: "broker:one",
      protocolVersion: 1,
      requestId: "shutdown",
      type: "shutdown",
    });
    expect(port.sent.at(-1)).toMatchObject({ ok: true, requestId: "shutdown", requestType: "shutdown" });
    expect(shutdowns).toBe(1);
    const sent = port.sent.length;
    port.receive({
      brokerId: "broker:one",
      cols: 80,
      ownerId: 7,
      protocolVersion: 1,
      requestId: "ignored",
      rows: 24,
      terminalId: "terminal:ignored",
      type: "open",
    });
    expect(port.sent).toHaveLength(sent);
    endpoint.dispose();
    expect(shutdowns).toBe(1);
  });
});
