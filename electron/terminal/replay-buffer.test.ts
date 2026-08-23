import { describe, expect, test } from "bun:test";
import type { TerminalSnapshot } from "./protocol.js";
import { TerminalReplayBuffer, type TerminalReplaySnapshot } from "./replay-buffer.js";

function assertReadonlyReplayApi(
  replaySnapshot: TerminalReplaySnapshot,
  terminalSnapshot: TerminalSnapshot,
): void {
  // @ts-expect-error replay chunk records are readonly
  replaySnapshot.chunks[0]!.data = "changed";
  // @ts-expect-error terminal snapshot replay collection is readonly
  terminalSnapshot.replay = [];
  // @ts-expect-error terminal snapshot replay array is readonly
  terminalSnapshot.replay.push({ data: "changed", sequence: 2 });
}
void assertReadonlyReplayApi;

describe("TerminalReplayBuffer", () => {
  test("evicts whole oldest chunks while preserving order, bytes, and the latest sequence", () => {
    const buffer = new TerminalReplayBuffer(5);
    buffer.append(1, "aa");
    buffer.append(2, "界");
    buffer.append(3, "b");

    expect(buffer.snapshot()).toEqual({
      bytes: 4,
      chunks: [
        { data: "界", sequence: 2 },
        { data: "b", sequence: 3 },
      ],
      sequence: 3,
      truncated: true,
    });
  });

  test("retains a valid UTF-8-safe tail when one incoming chunk exceeds capacity", () => {
    const buffer = new TerminalReplayBuffer(7);
    buffer.append(1, "old");
    buffer.append(2, "A😀界B");

    const snapshot = buffer.snapshot();
    expect(snapshot).toEqual({
      bytes: 4,
      chunks: [{ data: "界B", sequence: 2 }],
      sequence: 2,
      truncated: true,
    });
    expect(Buffer.byteLength(snapshot.chunks[0]?.data ?? "", "utf8")).toBeLessThanOrEqual(7);
    expect(snapshot.chunks[0]?.data.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });

  test("clear retains the latest sequence so stale or duplicate appends remain invalid", () => {
    const buffer = new TerminalReplayBuffer(16);
    buffer.append(5, "old");
    buffer.clear();

    expect(buffer.snapshot()).toEqual({
      bytes: 0,
      chunks: [],
      sequence: 5,
      truncated: false,
    });
    for (const invalidSequence of [0, -1, 1.5, 4, 5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buffer.append(invalidSequence, "stale")).toThrow();
    }
    expect(() => buffer.append(6, "")).toThrow();

    buffer.append(6, "new");
    expect(buffer.snapshot()).toMatchObject({
      bytes: 3,
      chunks: [{ data: "new", sequence: 6 }],
      sequence: 6,
    });
    expect(() => new TerminalReplayBuffer(0)).toThrow();
    expect(() => new TerminalReplayBuffer(1.5)).toThrow();
  });

  test("returns immutable snapshot copies that cannot mutate internal chunks", () => {
    const buffer = new TerminalReplayBuffer(16);
    buffer.append(1, "one");
    const snapshot = buffer.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.chunks)).toBe(true);
    expect(Object.isFrozen(snapshot.chunks[0])).toBe(true);
    expect(() => {
      (snapshot.chunks as Array<{ data: string; sequence: number }>).push({ data: "injected", sequence: 2 });
    }).toThrow();
    expect(() => {
      (snapshot.chunks[0] as { data: string; sequence: number }).data = "changed";
    }).toThrow();

    expect(buffer.snapshot()).toEqual({
      bytes: 3,
      chunks: [{ data: "one", sequence: 1 }],
      sequence: 1,
      truncated: false,
    });
  });

  test("rejects non-string and ill-formed data at append without mutating replay state", () => {
    const buffer = new TerminalReplayBuffer(4);
    buffer.append(1, "safe");
    const before = buffer.snapshot();
    const invalidValues = [
      42 as unknown as string,
      { value: "text" } as unknown as string,
      null as unknown as string,
      undefined as unknown as string,
      "\ud800",
      "prefix\udc00suffix",
    ];

    for (const invalid of invalidValues) {
      expect(() => buffer.append(2, invalid)).toThrow(
        "data must be a non-empty well-formed UTF-16 string",
      );
      expect(buffer.snapshot()).toEqual(before);
    }

    buffer.append(2, "next");
    expect(buffer.snapshot()).toEqual({
      bytes: 4,
      chunks: [{ data: "next", sequence: 2 }],
      sequence: 2,
      truncated: true,
    });
  });
});
