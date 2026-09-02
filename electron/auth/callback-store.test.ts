import { describe, expect, test } from "bun:test";

import { DesktopAuthCallbackStore } from "./callback-store";

describe("DesktopAuthCallbackStore", () => {
  test("accepts only the callback state captured from the authorization URL", () => {
    let now = 1_000;
    const store = new DesktopAuthCallbackStore({ now: () => now, ttlMs: 600 });
    store.beginAuthorization("https://auth.example/authorize?state=expected");

    expect(() => store.acceptCallback("http://127.0.0.1:17631/auth/callback?grant=invalid-grant-1234567890&state=wrong"))
      .toThrow("auth callback state mismatch");
    expect(() =>
      store.acceptCallback(
        "http://127.0.0.1:17631/auth/callback?grant=invalid-grant-1234567890&state=expected&state=expected",
      ),
    ).toThrow("auth callback state mismatch");
    expect(store.acceptCallback("http://127.0.0.1:17631/auth/callback?grant=one-time-grant-1234567890&state=expected"))
      .toEqual({ id: 1, grant: "one-time-grant-1234567890" });
    expect(store.getPending()).toEqual({ id: 1, grant: "one-time-grant-1234567890" });

    expect(() =>
      store.acceptCallback("http://127.0.0.1:17631/auth/callback?grant=replay-grant-1234567890&state=expected"),
    ).toThrow("auth callback state mismatch");
    expect(store.getPending()).toEqual({ id: 1, grant: "one-time-grant-1234567890" });

    now = 1_601;
    expect(store.getPending()).toBeNull();
  });

  test("expires and cancels authorization state before a callback arrives", () => {
    let now = 1_000;
    const store = new DesktopAuthCallbackStore({ now: () => now, ttlMs: 600 });
    store.beginAuthorization("https://auth.example/authorize?state=expired");

    now = 1_601;
    expect(() =>
      store.acceptCallback("http://127.0.0.1:17631/auth/callback?grant=late-grant-1234567890&state=expired"),
    ).toThrow("auth authorization state expired");

    const cancelledAuthorization = store.beginAuthorization("https://auth.example/authorize?state=cancelled");
    expect(store.cancelAuthorization(cancelledAuthorization)).toBe(true);
    expect(() =>
      store.acceptCallback("http://127.0.0.1:17631/auth/callback?grant=late-grant-1234567890&state=cancelled"),
    ).toThrow("auth callback state mismatch");
  });

  test("does not let a failed older launch cancel the current authorization", () => {
    const store = new DesktopAuthCallbackStore();
    const older = store.beginAuthorization("https://auth.example/authorize?state=older");
    const current = store.beginAuthorization("https://auth.example/authorize?state=current");

    expect(store.cancelAuthorization(older)).toBe(false);
    expect(store.acceptCallback("http://127.0.0.1:17631/auth/callback?grant=one-time-grant-1234567890&state=current"))
      .toEqual({ id: 1, grant: "one-time-grant-1234567890" });
    expect(store.cancelAuthorization(current)).toBe(false);
  });

  test("acknowledges a callback exactly once", () => {
    const store = new DesktopAuthCallbackStore({ now: () => 1_000, ttlMs: 600 });
    store.beginAuthorization("https://auth.example/authorize?state=expected");
    store.acceptCallback("http://127.0.0.1:17631/auth/callback?grant=one-time-grant-1234567890&state=expected");

    expect(store.complete(1)).toBe(true);
    expect(store.complete(1)).toBe(false);
  });

  test("rejects missing, duplicate, oversized grants and unexpected callback fields", () => {
    const store = new DesktopAuthCallbackStore();
    store.beginAuthorization("https://auth.example/authorize?state=expected");
    expect(() => store.acceptCallback("http://127.0.0.1:17631/auth/callback?state=expected"))
      .toThrow("auth callback grant is invalid");
    expect(() => store.acceptCallback("http://127.0.0.1:17631/auth/callback?state=expected&grant=a&grant=b"))
      .toThrow("auth callback grant is invalid");
    expect(() => store.acceptCallback(`http://127.0.0.1:17631/auth/callback?state=expected&grant=${"a".repeat(4097)}`))
      .toThrow("auth callback grant is invalid");
    expect(() => store.acceptCallback("http://127.0.0.1:17631/auth/callback?state=expected&grant=valid-grant-1234567890&code=forbidden"))
      .toThrow("auth callback URL is invalid");
  });
});
