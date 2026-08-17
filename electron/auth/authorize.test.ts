import { describe, expect, test } from "bun:test";

import { DESKTOP_AUTH_CALLBACK_URL } from "./callback-store";
import { isAuth0AuthorizeUrlAllowed } from "./authorize";

const options = {
  domain: "https://auth.example.com/",
  clientId: "client-id",
};

describe("Auth0 authorize URL policy", () => {
  test("allows the configured client and loopback callback", () => {
    const url = new URL("https://auth.example.com/authorize");
    url.searchParams.set("client_id", "client-id");
    url.searchParams.set("redirect_uri", DESKTOP_AUTH_CALLBACK_URL);
    url.searchParams.set("state", "opaque-state");

    expect(isAuth0AuthorizeUrlAllowed(url.toString(), options)).toBe(true);
  });

  test("rejects another client or redirect target", () => {
    const base = "https://auth.example.com/authorize?client_id=client-id";
    expect(
      isAuth0AuthorizeUrlAllowed(`${base}&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback`, options),
    ).toBe(false);
    expect(
      isAuth0AuthorizeUrlAllowed(
        `${base}&redirect_uri=${encodeURIComponent(DESKTOP_AUTH_CALLBACK_URL)}&client_id=other-client`,
        options,
      ),
    ).toBe(false);
  });

  test("rejects duplicate security parameters and an untrusted tenant", () => {
    const callback = encodeURIComponent(DESKTOP_AUTH_CALLBACK_URL);
    expect(
      isAuth0AuthorizeUrlAllowed(
        `https://auth.example.com/authorize?client_id=client-id&client_id=other&redirect_uri=${callback}`,
        options,
      ),
    ).toBe(false);
    expect(
      isAuth0AuthorizeUrlAllowed(
        `https://evil.example.com/authorize?client_id=client-id&redirect_uri=${callback}`,
        options,
      ),
    ).toBe(false);
  });
});
