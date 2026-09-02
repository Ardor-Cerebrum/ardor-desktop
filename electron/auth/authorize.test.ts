import { describe, expect, test } from "bun:test";

import { DESKTOP_AUTH_CALLBACK_URL } from "./callback-store";
import { isAuth0AuthorizeUrlAllowed } from "./authorize";

const options = {
  domain: "https://auth.example.com/",
  clientId: "client-id",
  expectedState: "opaque-state",
};

function validAuthorizeUrl(): URL {
  const url = new URL("https://auth.example.com/authorize");
  url.searchParams.set("client_id", "client-id");
  url.searchParams.set("redirect_uri", DESKTOP_AUTH_CALLBACK_URL);
  url.searchParams.set("state", "opaque-state");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", "A".repeat(43));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", "opaque-nonce");
  return url;
}

describe("Auth0 authorize URL policy", () => {
  test("allows the configured client and loopback callback", () => {
    expect(isAuth0AuthorizeUrlAllowed(validAuthorizeUrl().toString(), options)).toBe(true);
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
    const duplicate = validAuthorizeUrl();
    duplicate.searchParams.append("client_id", "other");
    expect(isAuth0AuthorizeUrlAllowed(duplicate.toString(), options)).toBe(false);
    const untrusted = validAuthorizeUrl();
    untrusted.hostname = "evil.example.com";
    expect(isAuth0AuthorizeUrlAllowed(untrusted.toString(), options)).toBe(false);
  });

  test("requires the exact single state, client, redirect, and no fragment", () => {
    for (const mutate of [
      (url: URL) => url.searchParams.set("client_id", "other-client"),
      (url: URL) => url.searchParams.append("client_id", "client-id"),
      (url: URL) => url.searchParams.set("redirect_uri", "http://127.0.0.1:17631/other"),
      (url: URL) => url.searchParams.append("redirect_uri", DESKTOP_AUTH_CALLBACK_URL),
      (url: URL) => url.searchParams.set("state", "wrong-state"),
      (url: URL) => url.searchParams.append("state", "opaque-state"),
      (url: URL) => { url.hash = "forbidden"; },
    ]) {
      const url = validAuthorizeUrl();
      mutate(url);
      expect(isAuth0AuthorizeUrlAllowed(url.toString(), options)).toBe(false);
    }
  });

  test("requires exact authorization-code PKCE and nonce parameters", () => {
    for (const mutate of [
      (url: URL) => url.searchParams.delete("response_type"),
      (url: URL) => url.searchParams.set("response_type", "token"),
      (url: URL) => url.searchParams.append("response_type", "code"),
      (url: URL) => url.searchParams.delete("code_challenge"),
      (url: URL) => url.searchParams.set("code_challenge", "short"),
      (url: URL) => url.searchParams.append("code_challenge", "B".repeat(43)),
      (url: URL) => url.searchParams.set("code_challenge_method", "plain"),
      (url: URL) => url.searchParams.delete("nonce"),
      (url: URL) => url.searchParams.append("nonce", "other"),
    ]) {
      const url = validAuthorizeUrl();
      mutate(url);
      expect(isAuth0AuthorizeUrlAllowed(url.toString(), options)).toBe(false);
    }
  });
});
