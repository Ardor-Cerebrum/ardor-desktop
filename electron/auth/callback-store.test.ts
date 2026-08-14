import { describe, expect, test } from "bun:test";

import { DesktopAuthCallbackStore } from "./callback-store";

describe("DesktopAuthCallbackStore", () => {
  test("accepts only the callback state captured from the authorization URL", () => {
    let now = 1_000;
    const store = new DesktopAuthCallbackStore({ now: () => now, ttlMs: 600 });
    store.beginAuthorization("https://auth.example/authorize?state=expected");

    expect(() => store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=bad&state=wrong"))
      .toThrow("auth callback state mismatch");
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

    store.beginAuthorization("https://auth.example/authorize?state=cancelled");
    store.cancelAuthorization();
    expect(() =>
      store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=late&state=cancelled"),
    ).toThrow("auth callback state mismatch");
  });

  test("acknowledges a callback exactly once", () => {
    const store = new DesktopAuthCallbackStore({ now: () => 1_000, ttlMs: 600 });
    store.beginAuthorization("https://auth.example/authorize?state=expected");
    store.acceptCallback("http://127.0.0.1:17631/auth/callback?code=good&state=expected");

    expect(store.complete(1)).toBe(true);
    expect(store.complete(1)).toBe(false);
  });
});
