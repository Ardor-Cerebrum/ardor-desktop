import assert from "node:assert/strict";
import test from "node:test";

import { validateBuiltUiConfig } from "./electron-stage-build.mjs";

test("accepts a stage UI bundle with the configured API and Auth0 values", () => {
  assert.doesNotThrow(() =>
    validateBuiltUiConfig(
      "https://stage1.dev.ardor.cloud auth-dev.ardor.cloud NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
      {
        apiUrl: "https://stage1.dev.ardor.cloud",
        auth0Domain: "auth-dev.ardor.cloud",
        auth0ClientId: "NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
      },
    ),
  );
});

test("rejects the test placeholder UI bundle before packaging", () => {
  assert.throws(
    () =>
      validateBuiltUiConfig("https://api.test auth.test client-id", {
        apiUrl: "https://stage1.dev.ardor.cloud",
        auth0Domain: "auth-dev.ardor.cloud",
        auth0ClientId: "NlqrCrYKElirtRUiozeLDR9PHbVxyrRE",
      }),
    /does not contain the expected stage configuration/,
  );
});
