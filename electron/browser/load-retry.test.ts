import { describe, expect, mock, test } from "bun:test";

import { BrowserLoadRetry } from "./load-retry";

function createRetryHarness() {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const cancelled = new Set<ReturnType<typeof setTimeout>>();
  const load = mock(async () => undefined);
  let destroyed = false;
  const retry = new BrowserLoadRetry(
    {
      isDestroyed: () => destroyed,
      load,
    },
    {
      schedule: (callback, delayMs) => {
        callbacks.push(callback);
        delays.push(delayMs);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: (timer) => cancelled.add(timer),
    },
  );
  return { callbacks, cancelled, delays, load, retry, setDestroyed: (value: boolean) => (destroyed = value) };
}

describe("Browser load retry", () => {
  test("retries one tab independently five times with bounded exponential backoff", async () => {
    const harness = createRetryHarness();
    harness.retry.reset("https://example.com/");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(harness.retry.failed()).toBe(true);
      harness.callbacks.at(-1)?.();
      await Promise.resolve();
    }

    expect(harness.retry.failed()).toBe(false);
    expect(harness.delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(harness.load).toHaveBeenCalledTimes(5);
    expect(harness.load).toHaveBeenCalledWith("https://example.com/");
  });

  test("a user navigation restores the retry budget for its new URL", () => {
    const harness = createRetryHarness();
    harness.retry.reset("https://first.example/");
    expect(harness.retry.failed()).toBe(true);

    harness.retry.reset("https://second.example/");
    expect(harness.retry.failed()).toBe(true);
    harness.callbacks.at(-1)?.();

    expect(harness.cancelled).toContain(1 as unknown as ReturnType<typeof setTimeout>);
    expect(harness.load).toHaveBeenCalledWith("https://second.example/");
    expect(harness.delays).toEqual([1_000, 1_000]);
  });

  test("successful load, stop, and destruction prevent a pending retry", () => {
    const loaded = createRetryHarness();
    loaded.retry.reset("https://example.com/");
    loaded.retry.failed();
    loaded.retry.loaded();
    expect(loaded.cancelled).toContain(1 as unknown as ReturnType<typeof setTimeout>);
    expect(loaded.load).not.toHaveBeenCalled();

    const stopped = createRetryHarness();
    stopped.retry.reset("https://example.com/");
    stopped.retry.failed();
    stopped.retry.stop();
    expect(stopped.cancelled).toContain(1 as unknown as ReturnType<typeof setTimeout>);
    expect(stopped.load).not.toHaveBeenCalled();

    const destroyed = createRetryHarness();
    destroyed.retry.reset("https://example.com/");
    destroyed.retry.failed();
    destroyed.setDestroyed(true);
    destroyed.callbacks[0]?.();
    expect(destroyed.load).not.toHaveBeenCalled();
  });
});
