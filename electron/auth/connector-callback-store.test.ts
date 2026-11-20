import { describe, expect, test } from "bun:test";

import { DESKTOP_CONNECTOR_CALLBACK_URL, DesktopConnectorCallbackStore, isConnectorState } from "./connector-callback-store";

const STATE = "d3skt0p-St4te_0123456789abcdef";
const callback = (query: string) => `${DESKTOP_CONNECTOR_CALLBACK_URL}?${query}`;
const good = `connector=gitlab&status=connected&state=${STATE}`;

describe("DesktopConnectorCallbackStore", () => {
  test("accepts the browser return that carries the registered state, once", () => {
    const store = new DesktopConnectorCallbackStore();
    store.begin(STATE);

    expect(store.accept(callback(good))).toEqual({ provider: "gitlab", status: "connected" });
    expect(() => store.accept(callback(good))).toThrow("state mismatch");
  });

  test("reports a failed sign-in with the same state check", () => {
    const store = new DesktopConnectorCallbackStore();
    store.begin(STATE);

    expect(store.accept(callback(`connector=slack&status=error&state=${STATE}`))).toEqual({
      provider: "slack",
      status: "error",
    });
  });

  test("refuses a return when nothing was registered, or with another state", () => {
    const store = new DesktopConnectorCallbackStore();
    expect(() => store.accept(callback(good))).toThrow("state mismatch");

    store.begin(STATE);
    expect(() => store.accept(callback(good.replace(STATE, `${STATE.slice(0, -1)}X`)))).toThrow("state mismatch");
    // A wrong guess does not consume the real sign-in.
    expect(store.accept(callback(good))).toEqual({ provider: "gitlab", status: "connected" });
  });

  test("refuses repeated or missing parameters", () => {
    const store = new DesktopConnectorCallbackStore();
    store.begin(STATE);

    expect(() => store.accept(callback(`${good}&state=${STATE}`))).toThrow("state mismatch");
    expect(() => store.accept(callback(`connector=gitlab&status=connected`))).toThrow("state mismatch");
    expect(() => store.accept(callback(`status=connected&state=${STATE}`))).toThrow("result is invalid");
    expect(() => store.accept(callback(`connector=gitlab&state=${STATE}`))).toThrow("result is invalid");
  });

  test.each(["", "GITLAB", "git lab", "1gitlab", "a".repeat(33), "gitlab/../x"])(
    "refuses a provider that is not a plain connector id (%p)",
    (provider) => {
      const store = new DesktopConnectorCallbackStore();
      store.begin(STATE);

      expect(() =>
        store.accept(callback(`connector=${encodeURIComponent(provider)}&status=connected&state=${STATE}`)),
      ).toThrow("result is invalid");
    },
  );

  test.each(["", "ok", "CONNECTED", "connected ", "success"])("refuses a status that is not connected or error (%p)", (status) => {
    const store = new DesktopConnectorCallbackStore();
    store.begin(STATE);

    expect(() =>
      store.accept(callback(`connector=gitlab&status=${encodeURIComponent(status)}&state=${STATE}`)),
    ).toThrow("result is invalid");
  });

  test("refuses another address, host or path", () => {
    const store = new DesktopConnectorCallbackStore();
    store.begin(STATE);

    for (const url of [
      `http://127.0.0.1:17631/auth/callback?${good}`,
      `http://127.0.0.1:17632/connector/callback?${good}`,
      `http://localhost:17631/connector/callback?${good}`,
      `https://127.0.0.1:17631/connector/callback?${good}`,
    ]) {
      expect(() => store.accept(url)).toThrow("callback URL is invalid");
    }
  });

  test("expires a sign-in left open past its time-to-live, at the boundary", () => {
    let now = 1_000;
    const store = new DesktopConnectorCallbackStore({ now: () => now, ttlMs: 100 });

    store.begin(STATE);
    now = 1_099;
    expect(store.accept(callback(good))).toEqual({ provider: "gitlab", status: "connected" });

    store.begin(STATE);
    now = 1_199 + 1;
    expect(() => store.accept(callback(good))).toThrow("expired");
  });

  test("forgets a sign-in that was cancelled, but only for that state", () => {
    const store = new DesktopConnectorCallbackStore();
    store.begin(STATE);

    store.cancel("another-state-0123456789abc");
    expect(store.accept(callback(good)).status).toBe("connected");

    store.begin(STATE);
    store.cancel(STATE);
    expect(() => store.accept(callback(good))).toThrow("state mismatch");
  });

  test("replaces an earlier pending sign-in with the newest one", () => {
    const store = new DesktopConnectorCallbackStore();
    const newer = "n3wer-St4te_0123456789abcdefg";
    store.begin(STATE);
    store.begin(newer);

    expect(() => store.accept(callback(good))).toThrow("state mismatch");
    expect(store.accept(callback(good.replace(STATE, newer))).status).toBe("connected");
  });

  test("rejects a state that is not an opaque token", () => {
    const store = new DesktopConnectorCallbackStore();
    for (const value of ["", "short", "a".repeat(65), `${STATE}&x=1`, `${STATE}/..`, 42, undefined, null]) {
      expect(() => store.begin(value)).toThrow("connector state is invalid");
    }
  });

  test("requires a positive time-to-live", () => {
    expect(() => new DesktopConnectorCallbackStore({ ttlMs: 0 })).toThrow(RangeError);
  });
});

describe("isConnectorState", () => {
  test.each([
    ["a".repeat(22), true],
    ["a".repeat(21), false],
    ["a".repeat(64), true],
    ["a".repeat(65), false],
    ["A-_".repeat(10), true],
  ])("length and alphabet boundary %p", (value, expected) => {
    expect(isConnectorState(value)).toBe(expected);
  });
});
