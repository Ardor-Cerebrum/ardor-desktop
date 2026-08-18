import { describe, expect, test } from "bun:test";

import { DesktopAuthCallbackStore } from "./callback-store";

describe("DesktopAuthCallbackStore", () => {
  test("accepts only the callback state captured from the authorization URL", () => {
    let now = 1_000;
    const store = new DesktopAuthCallbackStore({ now: () => now, ttlMs: 600 });
    store.beginAuthorization("https://auth.example/authorize?state=expected");

    expect(() => store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=bad&state=wrong"))
      .toThrow("auth callback state mismatch");
    expect(() =>
      store.acceptCallback(
        "http://127.0.0.1:17631/auth/callback?code=bad&state=expected&state=expected",
      ),
    ).toThrow("auth callback state mismatch");
    expect(store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=good&state=expected"))
      .toEqual({ id: 1, callbackUrl: "http://127.0.0.1:17631/auth/callback?code=good&state=expected" });
    expect(store.getPending()).toEqual({
      id: 1,
      callbackUrl: "http://127.0.0.1:17631/auth/callback?code=good&state=expected",
    });

    expect(() =>
      store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=replay&state=expected"),
    ).toThrow("auth callback state mismatch");
    expect(store.getPending()).toEqual({
      id: 1,
      callbackUrl: "http://127.0.0.1:17631/auth/callback?code=good&state=expected",
    });

    now = 1_601;
    expect(store.getPending()).toBeNull();
  });

  test("expires and cancels authorization state before a callback arrives", () => {
    let now = 1_000;
    const store = new DesktopAuthCallbackStore({ now: () => now, ttlMs: 600 });
    store.beginAuthorization("https://auth.example/authorize?state=expired");

    now = 1_601;
    expect(() =>
      store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=late&state=expired"),
    ).toThrow("auth authorization state expired");

    const cancelledAuthorization = store.beginAuthorization("https://auth.example/authorize?state=cancelled");
    expect(store.cancelAuthorization(cancelledAuthorization)).toBe(true);
    expect(() =>
      store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=late&state=cancelled"),
    ).toThrow("auth callback state mismatch");
  });

  test("does not let a failed older launch cancel the current authorization", () => {
    const store = new DesktopAuthCallbackStore();
    const older = store.beginAuthorization("https://auth.example/authorize?state=older");
    const current = store.beginAuthorization("https://auth.example/authorize?state=current");

    expect(store.cancelAuthorization(older)).toBe(false);
    expect(store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=good&state=current"))
      .toEqual({
        id: 1,
        callbackUrl: "http://127.0.0.1:17631/auth/callback?code=good&state=current",
      });
    expect(store.cancelAuthorization(current)).toBe(false);
  });

  test("acknowledges a callback exactly once", () => {
    const store = new DesktopAuthCallbackStore({ now: () => 1_000, ttlMs: 600 });
    store.beginAuthorization("https://auth.example/authorize?state=expected");
    store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=good&state=expected");

    expect(store.complete(1)).toBe(true);
    expect(store.complete(1)).toBe(false);
  });
});
