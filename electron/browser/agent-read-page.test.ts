import { describe, expect, test } from "bun:test";

import type { BrowserTabHandle } from "./browser-surface";
import { readBrowserPage } from "./agent-read-page";

function handleWithResponses(responses: unknown[]) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const handle = {
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return responses.shift();
    },
  } as BrowserTabHandle;
  return { calls, handle };
}

describe("readBrowserPage", () => {
  test("reads the main frame in an isolated world", async () => {
    const { calls, handle } = handleWithResponses([
      { frameTree: { frame: { id: "frame-1" } } },
      { executionContextId: 42 },
      {
        result: {
          value: {
            elements: [{ name: "Search", ref: "ref_1", role: "textbox" }],
            title: "Example",
            truncated: false,
            url: "https://example.com/",
          },
        },
      },
    ]);

    await expect(readBrowserPage(handle)).resolves.toMatchObject({
      title: "Example",
      url: "https://example.com/",
    });
    expect(calls.map((call) => call.method)).toEqual([
      "Page.getFrameTree",
      "Page.createIsolatedWorld",
      "Runtime.evaluate",
    ]);
    expect(calls[1]?.params).toEqual({
      frameId: "frame-1",
      grantUniveralAccess: false,
      worldName: "ardor-browser-agent-v1",
    });
    expect(calls[2]?.params?.expression).toContain('"[value redacted]"');
    expect(calls[2]?.params?.expression).not.toContain("outerHTML");
  });

  test("rejects malformed page results", async () => {
    const { handle } = handleWithResponses([
      { frameTree: { frame: { id: "frame-1" } } },
      { executionContextId: 42 },
      { result: { value: { title: "missing fields" } } },
    ]);

    await expect(readBrowserPage(handle)).rejects.toThrow("invalid snapshot");
  });
});
