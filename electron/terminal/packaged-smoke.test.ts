import { describe, expect, mock, test } from "bun:test";

import type { TerminalClientEvent, TerminalClientResponse } from "./client-contract.js";
import { runPackagedTerminalSmoke } from "./packaged-smoke.js";

function snapshot(generation = 1) {
  return {
    cols: 80,
    cwd: "C:\\workspace",
    exitCode: null,
    generation,
    profileId: "windows-powershell" as const,
    replay: [],
    rows: 24,
    sequence: 0,
    shell: "cmd.exe",
    status: "running" as const,
    terminalId: "packaged-smoke",
    truncated: false,
  };
}

describe("packaged terminal smoke", () => {
  test("opens, resizes, writes a marker, observes PTY output, closes, and shuts down", async () => {
    let listener: ((ownerId: number, event: TerminalClientEvent) => void) | undefined;
    const close = mock(async () => ({ ok: true, requestType: "close" } satisfies TerminalClientResponse));
    const onEvent = mock((next: typeof listener) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    });
    const open = mock(async () => ({ ok: true, requestType: "open", snapshot: snapshot() } satisfies TerminalClientResponse));
    const listProfiles = mock(async () => ({
      catalog: {
        defaultProfileId: "windows-powershell" as const,
        profiles: [{ id: "windows-powershell" as const, label: "Windows PowerShell" }],
      },
      ok: true as const,
      requestType: "listProfiles" as const,
    } satisfies TerminalClientResponse));
    const resize = mock(async () => ({ ok: true, requestType: "resize" } satisfies TerminalClientResponse));
    const write = mock(async (_ownerId: number, _terminalId: string, _generation: number, data: string) => {
      const marker = data.match(/ARDOR_TERMINAL_SMOKE_[A-Z0-9]+/)?.[0];
      if (marker) {
        listener?.(42, {
          data: `${marker}\r\n`,
          generation: 1,
          sequence: 1,
          terminalId: "packaged-smoke",
          type: "data",
        });
      }
      return { ok: true, requestType: "write" } satisfies TerminalClientResponse;
    });
    const gateway = {
      close,
      listProfiles,
      onEvent,
      open,
      resize,
      write,
    };
    const supervisor = { shutdown: mock(async () => undefined) };

    await runPackagedTerminalSmoke({
      gateway,
      ownerId: 42,
      platform: "win32",
      supervisor,
      terminalId: "packaged-smoke",
      timeoutMs: 100,
    });

    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(42, "packaged-smoke", {
      cols: 80,
      profileId: "windows-powershell",
      rows: 24,
    });
    expect(resize).toHaveBeenCalledWith(42, "packaged-smoke", 1, 100, 30);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[3]).toContain("ARDOR_TERMINAL_SMOKE_");
    expect(close).toHaveBeenCalledWith(42, "packaged-smoke", 1);
    expect(supervisor.shutdown).toHaveBeenCalledTimes(1);
  });
});
