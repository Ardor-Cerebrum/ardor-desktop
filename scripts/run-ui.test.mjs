import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./run-ui.mjs", import.meta.url));

for (const missing of ["VITE_TILE_APP_REGISTRY_URL", "VITE_TILE_APP_REGISTRY_CHANNEL"]) {
  test(`rejects a production UI build without ${missing} before launching Vite`, () => {
    const result = spawnSync(process.execPath, [script, "prod", "build"], {
      env: {
        ...process.env,
        VITE_API_URL: "https://console.ardor.cloud",
        VITE_ARTIFACT_API_URL: "https://artifact.ardor.build/artifact-api",
        VITE_AUTH0_DOMAIN: "auth.ardor.cloud",
        VITE_AUTH0_CLIENT_ID: "production-test-client",
        VITE_TILE_APP_REGISTRY_URL: "https://console.ardor.cloud/tile-app-registry",
        VITE_TILE_APP_REGISTRY_CHANNEL: "stable",
        [missing]: "",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Missing required prod desktop UI env: ${missing}`));
  });
}
