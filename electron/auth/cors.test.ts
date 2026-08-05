import { describe, expect, test } from "bun:test";

import { rewriteAuth0TokenCorsHeaders } from "./cors";

describe("Auth0 token CORS headers", () => {
  test("scopes token responses to the trusted Electron shell origin", () => {
    expect(
      rewriteAuth0TokenCorsHeaders(
        {
          "content-type": ["application/json"],
          "access-control-allow-origin": ["*"],
        },
        "ardor://app",
      ),
    ).toEqual({
      "content-type": ["application/json"],
      "Access-Control-Allow-Origin": ["ardor://app"],
      "Access-Control-Allow-Credentials": ["true"],
      "Access-Control-Allow-Headers": ["Content-Type, Authorization, Auth0-Client, X-Requested-With"],
      "Access-Control-Allow-Methods": ["POST, OPTIONS"],
    });
  });
});
