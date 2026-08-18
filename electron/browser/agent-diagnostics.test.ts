import { describe, expect, mock, test } from "bun:test";

import { BrowserAgentDiagnostics } from "./agent-diagnostics";

describe("BrowserAgentDiagnostics", () => {
  test("captures bounded console and network diagnostics for the committed origin", async () => {
    const sendCommand = mock(async () => ({ base64Encoded: false, body: "response" }));
    const diagnostics = new BrowserAgentDiagnostics(sendCommand);
    diagnostics.committed("https://example.com/page");

    diagnostics.handle("Runtime.consoleAPICalled", {
      args: [{ value: "hello" }, { value: { ok: true } }],
      timestamp: 1,
      type: "info",
    });
    diagnostics.handle("Network.requestWillBeSent", {
      request: { method: "POST", url: "https://example.com/api" },
      requestId: "request-1",
      type: "Fetch",
      wallTime: 2,
    });
    diagnostics.handle("Network.responseReceived", {
      requestId: "request-1",
      response: { mimeType: "application/json", status: 201 },
      type: "Fetch",
    });

    expect(diagnostics.consoleMessages()).toEqual([
      { level: "info", origin: "https://example.com", text: 'hello {"ok":true}', timestamp: 1 },
    ]);
    expect(diagnostics.networkRequests()).toEqual([
      {
        method: "POST",
        mimeType: "application/json",
        requestId: "request-1",
        resourceType: "Fetch",
        status: 201,
        timestamp: 2_000,
        url: "https://example.com/api",
      },
    ]);
    await expect(diagnostics.responseBody("request-1")).resolves.toEqual({ base64Encoded: false, body: "response" });
    expect(sendCommand).toHaveBeenCalledWith("Network.getResponseBody", { requestId: "request-1" });
  });

  test("clears stale diagnostics when the main-frame origin changes", () => {
    const diagnostics = new BrowserAgentDiagnostics(async () => ({}));
    diagnostics.committed("https://example.com/a");
    diagnostics.handle("Runtime.exceptionThrown", { exceptionDetails: { text: "boom" } });
    diagnostics.handle("Network.requestWillBeSent", {
      request: { method: "GET", url: "https://example.com/a" },
      requestId: "request-1",
    });

    diagnostics.committed("https://other.example/b");

    expect(diagnostics.consoleMessages()).toEqual([]);
    expect(diagnostics.networkRequests()).toEqual([]);
  });

  test("bounds response bodies and rejects stale request ids", async () => {
    const diagnostics = new BrowserAgentDiagnostics(async () => ({ body: "x".repeat(11 * 1024) }));
    diagnostics.committed("https://example.com/");
    diagnostics.handle("Network.requestWillBeSent", {
      request: { method: "GET", url: "https://example.com/file" },
      requestId: "request-1",
    });

    await expect(diagnostics.responseBody("request-1")).resolves.toMatchObject({
      body: expect.stringContaining("[response body truncated]"),
    });
    await expect(diagnostics.responseBody("missing")).rejects.toThrow("unavailable or stale");
  });
});
