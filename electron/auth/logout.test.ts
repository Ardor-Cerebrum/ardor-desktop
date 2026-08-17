import { describe, expect, test } from "bun:test";

import { buildAuth0LogoutUrl } from "./logout";

describe("Auth0 logout URL", () => {
  test("builds a validated logout URL that returns to the Electron shell", () => {
    const result = buildAuth0LogoutUrl({
      domain: "https://auth.example.com/",
      allowedDomain: "auth.example.com",
      clientId: "client-id",
      returnTo: "ardor://app/index.html",
    });

    expect(result).toBe(
      "https://auth.example.com/v2/logout?client_id=client-id&returnTo=ardor%3A%2F%2Fapp%2Findex.html",
    );
  });

  test("rejects an untrusted logout domain or return target", () => {
    expect(() =>
      buildAuth0LogoutUrl({
        domain: "https://evil.example.com",
        allowedDomain: "auth.example.com",
        returnTo: "ardor://app/index.html",
      }),
    ).toThrow("Auth0 domain");
    expect(() =>
      buildAuth0LogoutUrl({ domain: "auth.example.com", returnTo: "https://evil.example.com" }),
    ).toThrow("logout return URL");
  });
});
