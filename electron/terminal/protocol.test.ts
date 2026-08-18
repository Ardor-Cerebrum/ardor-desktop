import { describe, expect, test } from "bun:test";

import {
  isTerminalBrokerMessage,
  isTerminalBrokerRequest,
  takeUtf8Tail,
  TERMINAL_LIMITS,
  utf8ByteLength,
} from "./protocol.js";

const envelope = {
  brokerId: "broker:one",
  protocolVersion: 1,
} as const;

describe("terminal broker protocol", () => {
  test("accepts a valid open request and data event while rejecting invalid envelope and identity fields", () => {
    const openRequest = {
      ...envelope,
      cols: 80,
      ownerId: 7,
      requestId: "request:open",
      rows: 24,
      terminalId: "terminal:one",
      type: "open",
    };
    const dataMessage = {
      ...envelope,
      event: {
        data: "prompt $ ",
        generation: 1,
        ownerId: 7,
        sequence: 1,
        terminalId: "terminal:one",
        type: "data",
      },
      type: "event",
    };

    expect(isTerminalBrokerRequest(openRequest)).toBe(true);
    expect(isTerminalBrokerRequest({ ...openRequest, profileId: "pwsh" })).toBe(true);
    expect(isTerminalBrokerRequest({ ...openRequest, profileId: "C:\\attacker.exe" })).toBe(false);
    expect(isTerminalBrokerMessage(dataMessage)).toBe(true);

    expect(isTerminalBrokerRequest({ ...openRequest, protocolVersion: 2 })).toBe(false);
    expect(isTerminalBrokerRequest({ ...openRequest, requestId: "" })).toBe(false);
    expect(isTerminalBrokerRequest({ ...openRequest, brokerId: "" })).toBe(false);
    expect(isTerminalBrokerRequest({ ...openRequest, cols: 1 })).toBe(false);
    expect(isTerminalBrokerRequest({ ...openRequest, rows: 501 })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...dataMessage,
      event: { ...dataMessage.event, generation: 0 },
    })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...dataMessage,
      event: { ...dataMessage.event, sequence: 0 },
    })).toBe(false);
  });

  test("strictly validates shell-profile discovery, selection, and snapshot identity", () => {
    const listRequest = {
      ...envelope,
      requestId: "request:profiles",
      type: "listProfiles",
    };
    const catalog = {
      defaultProfileId: "wsl-default",
      profiles: [
        { id: "wsl-default", label: "WSL (default)" },
        { id: "pwsh", label: "PowerShell 7" },
      ],
    };
    const response = {
      ...envelope,
      catalog,
      ok: true,
      requestId: listRequest.requestId,
      requestType: "listProfiles",
      type: "response",
    };

    expect(isTerminalBrokerRequest(listRequest)).toBe(true);
    expect(isTerminalBrokerMessage(response)).toBe(true);
    expect(isTerminalBrokerMessage({
      ...response,
      catalog: { ...catalog, defaultProfileId: "missing" },
    })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...response,
      catalog: { ...catalog, profiles: [...catalog.profiles, { id: "cmd", label: "PowerShell 7" }] },
    })).toBe(false);
    expect(isTerminalBrokerMessage({ ...response, executablePath: "C:\\attacker.exe" })).toBe(false);
  });

  test("limits terminal input to 64 KiB measured as UTF-8 bytes", () => {
    const writeRequest = {
      ...envelope,
      commandSequence: 1,
      data: "a".repeat(64 * 1024),
      generation: 1,
      ownerId: 7,
      requestId: "request:write",
      terminalId: "terminal:one",
      type: "write",
    };
    const multibyteOverflow = "界".repeat(21_846);

    expect(TERMINAL_LIMITS.INPUT_FRAME_BYTES).toBe(64 * 1024);
    expect(isTerminalBrokerRequest(writeRequest)).toBe(true);
    expect(isTerminalBrokerRequest({ ...writeRequest, data: `${writeRequest.data}a` })).toBe(false);
    expect(multibyteOverflow.length).toBeLessThan(TERMINAL_LIMITS.INPUT_FRAME_BYTES);
    expect(Buffer.byteLength(multibyteOverflow, "utf8")).toBeGreaterThan(TERMINAL_LIMITS.INPUT_FRAME_BYTES);
    expect(isTerminalBrokerRequest({ ...writeRequest, data: multibyteOverflow })).toBe(false);
  });

  test("requires positive safe generation and command sequences on every generation-bound request", () => {
    const orderedIdentity = {
      ...envelope,
      commandSequence: 1,
      generation: 1,
      ownerId: 7,
      requestId: "request:ordered",
      terminalId: "terminal:one",
    };
    const requests = [
      { ...orderedIdentity, type: "detach" },
      { ...orderedIdentity, data: "pwd\r", type: "write" },
      { ...orderedIdentity, cols: 120, rows: 40, type: "resize" },
      { ...orderedIdentity, sequence: 3, type: "ack" },
      { ...orderedIdentity, cols: 100, cwd: "/work/界", rows: 30, type: "restart" },
      { ...orderedIdentity, type: "close" },
      { ...orderedIdentity, type: "clear" },
    ];

    for (const request of requests) expect(isTerminalBrokerRequest(request)).toBe(true);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      for (const request of requests) {
        expect(isTerminalBrokerRequest({ ...request, generation: invalid })).toBe(false);
        expect(isTerminalBrokerRequest({ ...request, commandSequence: invalid })).toBe(false);
      }
    }

    expect(isTerminalBrokerRequest({
      ...envelope,
      ownerId: 7,
      requestId: "request:close-owner",
      type: "closeOwner",
    })).toBe(true);
    expect(isTerminalBrokerRequest({
      ...envelope,
      requestId: "request:shutdown",
      type: "shutdown",
    })).toBe(true);
    expect(isTerminalBrokerRequest({
      ...orderedIdentity,
      executablePath: "/bin/zsh",
      type: "detach",
    })).toBe(false);
  });

  test("takes the longest UTF-8-safe tail without splitting emoji or CJK code points", () => {
    const value = "A😀界B";

    expect(takeUtf8Tail(value, 9)).toEqual({ dropped: false, value });
    expect(takeUtf8Tail(value, 8)).toEqual({ dropped: true, value: "😀界B" });
    expect(takeUtf8Tail(value, 4)).toEqual({ dropped: true, value: "界B" });
    expect(takeUtf8Tail(value, 3)).toEqual({ dropped: true, value: "B" });
    expect(takeUtf8Tail(value, 0)).toEqual({ dropped: true, value: "" });

    const emojiTail = takeUtf8Tail("prefix😀", 4);
    expect(emojiTail.value).toBe("😀");
    expect(emojiTail.value.charCodeAt(0)).toBe(0xd83d);
  });

  test("validates ready, correlated responses, ordered events, and snapshots as strict unions", () => {
    const snapshot = {
      brokerId: envelope.brokerId,
      cols: 80,
      cwd: "/work/界",
      exitCode: null,
      generation: 1,
      ownerId: 7,
      replay: [
        { data: "prompt ", sequence: 1 },
        { data: "$ ", sequence: 2 },
      ],
      rows: 24,
      sequence: 2,
      profileId: "system",
      shell: "zsh",
      status: "running",
      terminalId: "terminal:one",
      truncated: false,
    };
    const success = {
      ...envelope,
      ok: true,
      requestId: "request:open",
      requestType: "open",
      snapshot,
      type: "response",
    };
    const failure = {
      ...envelope,
      error: { code: "NOT_FOUND", message: "terminal session is unavailable" },
      ok: false,
      requestId: "request:write",
      requestType: "write",
      type: "response",
    };
    const exit = {
      ...envelope,
      event: {
        exitCode: 0,
        generation: 1,
        ownerId: 7,
        sequence: 3,
        terminalId: "terminal:one",
        type: "exit",
      },
      type: "event",
    };
    const serviceLost = {
      ...envelope,
      event: {
        generation: 1,
        ownerId: 7,
        reason: "terminal broker exited",
        sequence: 4,
        terminalId: "terminal:one",
        type: "service-lost",
      },
      type: "event",
    };

    expect(isTerminalBrokerMessage({ ...envelope, type: "ready" })).toBe(true);
    expect(isTerminalBrokerMessage(success)).toBe(true);
    expect(isTerminalBrokerMessage({
      ...envelope,
      ok: true,
      requestId: "request:close",
      requestType: "close",
      type: "response",
    })).toBe(true);
    expect(isTerminalBrokerMessage(failure)).toBe(true);
    expect(isTerminalBrokerMessage(exit)).toBe(true);
    expect(isTerminalBrokerMessage(serviceLost)).toBe(true);
    expect(isTerminalBrokerMessage({
      ...envelope,
      ok: true,
      requestId: "request:clear",
      requestType: "clear",
      type: "response",
    })).toBe(true);
    expect(isTerminalBrokerMessage({ ...failure, error: { code: "INVALID_CWD", message: "invalid working directory" } })).toBe(true);

    expect(isTerminalBrokerMessage({ ...success, snapshot: { ...snapshot, brokerId: "broker:other" } })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, snapshot: { ...snapshot, replay: [{ data: "x", sequence: 0 }] } })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, snapshot: { ...snapshot, replay: [
      { data: "newer", sequence: 2 },
      { data: "older", sequence: 1 },
    ] } })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, snapshot: { ...snapshot, status: "running", exitCode: 1 } })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, snapshot: undefined })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...envelope,
      ok: true,
      requestId: "request:close",
      requestType: "close",
      snapshot,
      type: "response",
    })).toBe(false);
    expect(isTerminalBrokerMessage({ ...failure, error: { code: "UNKNOWN", message: "no" } })).toBe(false);
    expect(isTerminalBrokerMessage({ ...serviceLost, event: { ...serviceLost.event, data: "secret" } })).toBe(false);
  });

  test("publishes the exact frozen limits and enforces cwd and output byte boundaries", () => {
    expect(TERMINAL_LIMITS).toEqual({
      INPUT_FRAME_BYTES: 64 * 1024,
      MAX_CWD_CODE_UNITS: 4096,
      MAX_DIMENSION: 500,
      MAX_SESSIONS_GLOBAL: 32,
      MAX_SESSIONS_PER_OWNER: 8,
      MIN_DIMENSION: 2,
      OUTPUT_BATCH_BYTES: 64 * 1024,
      OUTPUT_BATCH_MS: 16,
      PAUSE_HIGH_WATER_BYTES: 512 * 1024,
      REPLAY_BYTES: 1024 * 1024,
      RESUME_LOW_WATER_BYTES: 128 * 1024,
    });
    expect(Object.isFrozen(TERMINAL_LIMITS)).toBe(true);

    const openRequest = {
      ...envelope,
      cols: 80,
      cwd: "x".repeat(4096),
      ownerId: 7,
      requestId: "request:open",
      rows: 24,
      terminalId: "terminal:one",
      type: "open",
    };
    expect(isTerminalBrokerRequest(openRequest)).toBe(true);
    expect(isTerminalBrokerRequest({ ...openRequest, cwd: `${openRequest.cwd}x` })).toBe(false);
    expect(isTerminalBrokerRequest({ ...openRequest, type: "execute" })).toBe(false);

    const dataMessage = {
      ...envelope,
      event: {
        data: "a".repeat(64 * 1024),
        generation: 1,
        ownerId: 7,
        sequence: 1,
        terminalId: "terminal:one",
        type: "data",
      },
      type: "event",
    };
    expect(isTerminalBrokerMessage(dataMessage)).toBe(true);
    expect(isTerminalBrokerMessage({
      ...dataMessage,
      event: { ...dataMessage.event, data: `${dataMessage.event.data}a` },
    })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...dataMessage,
      event: { ...dataMessage.event, data: "界".repeat(21_846) },
    })).toBe(false);
  });

  test("rejects ill-formed UTF-16 on every raw protocol string surface without normalizing valid strings", () => {
    const malformedStrings = [
      "\ud800leading",
      "middle\ud800value",
      "trailing\ud800",
      "\udc00leading",
      "middle\udc00value",
      "trailing\udc00",
    ];
    const validRaw = "e\u0301😀界";

    expect(takeUtf8Tail(validRaw, utf8ByteLength(validRaw))).toEqual({ dropped: false, value: validRaw });
    for (const malformed of malformedStrings) {
      expect(() => utf8ByteLength(malformed)).toThrow(TypeError);
      expect(() => takeUtf8Tail(malformed, 1024)).toThrow(TypeError);
      expect(() => takeUtf8Tail(malformed, 4)).toThrow(TypeError);
    }

    const openRequest = {
      ...envelope,
      cols: 80,
      cwd: "/work",
      ownerId: 7,
      requestId: "request:open",
      rows: 24,
      terminalId: "terminal:one",
      type: "open",
    };
    const writeRequest = {
      ...envelope,
      commandSequence: 1,
      data: "pwd\r",
      generation: 1,
      ownerId: 7,
      requestId: "request:write",
      terminalId: "terminal:one",
      type: "write",
    };
    const dataMessage = {
      ...envelope,
      event: {
        data: "prompt",
        generation: 1,
        ownerId: 7,
        sequence: 1,
        terminalId: "terminal:one",
        type: "data",
      },
      type: "event",
    };
    const snapshot = {
      brokerId: envelope.brokerId,
      cols: 80,
      cwd: "/work",
      exitCode: null,
      generation: 1,
      ownerId: 7,
      replay: [{ data: "prompt", sequence: 1 }],
      rows: 24,
      sequence: 1,
      shell: "zsh",
      status: "running",
      terminalId: "terminal:one",
      truncated: false,
    };
    const success = {
      ...envelope,
      ok: true,
      requestId: "request:open",
      requestType: "open",
      snapshot,
      type: "response",
    };
    const failure = {
      ...envelope,
      error: { code: "NOT_FOUND", message: "missing" },
      ok: false,
      requestId: "request:write",
      requestType: "write",
      type: "response",
    };
    const serviceLost = {
      ...envelope,
      event: {
        generation: 1,
        ownerId: 7,
        reason: "broker exited",
        sequence: 2,
        terminalId: "terminal:one",
        type: "service-lost",
      },
      type: "event",
    };
    const malformed = malformedStrings[1] as string;

    for (const data of malformedStrings) {
      expect(isTerminalBrokerRequest({ ...writeRequest, data })).toBe(false);
      expect(isTerminalBrokerMessage({ ...dataMessage, event: { ...dataMessage.event, data } })).toBe(false);
    }
    expect(isTerminalBrokerRequest({ ...openRequest, brokerId: malformed })).toBe(false);
    expect(isTerminalBrokerRequest({ ...openRequest, requestId: malformed })).toBe(false);
    expect(isTerminalBrokerRequest({ ...openRequest, terminalId: malformed })).toBe(false);
    expect(isTerminalBrokerRequest({ ...openRequest, cwd: malformed })).toBe(false);
    expect(isTerminalBrokerMessage({ ...dataMessage, brokerId: malformed })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...dataMessage,
      event: { ...dataMessage.event, terminalId: malformed },
    })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, requestId: malformed })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, snapshot: { ...snapshot, brokerId: malformed } })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, snapshot: { ...snapshot, cwd: malformed } })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, snapshot: { ...snapshot, shell: malformed } })).toBe(false);
    expect(isTerminalBrokerMessage({ ...success, snapshot: { ...snapshot, terminalId: malformed } })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...success,
      snapshot: { ...snapshot, replay: [{ data: malformed, sequence: 1 }] },
    })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...failure,
      error: { ...failure.error, message: malformed },
    })).toBe(false);
    expect(isTerminalBrokerMessage({
      ...serviceLost,
      event: { ...serviceLost.event, reason: malformed },
    })).toBe(false);
  });

  test("requires a non-negative safe integer UTF-8 tail byte bound", () => {
    expect(takeUtf8Tail("abc", 0)).toEqual({ dropped: true, value: "" });
    expect(takeUtf8Tail("abc", Number.MAX_SAFE_INTEGER)).toEqual({
      dropped: false,
      value: "abc",
    });

    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => takeUtf8Tail("abc", invalid)).toThrow(RangeError);
    }
    expect(() => takeUtf8Tail("abc", Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});
