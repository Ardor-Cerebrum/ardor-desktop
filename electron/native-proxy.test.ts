import { describe, expect, test } from "bun:test";

import {
  buildNativeProxyUrl,
  isNativeProxyPath,
  resolveNativeApiOrigin,
  sanitizeNativeProxyHeaders,
} from "./native-proxy";

describe("desktop Cerebrum native relay", () => {
  test("recognizes only native API paths", () => {
    expect(isNativeProxyPath("/cerebrum-native/session")).toBe(true);
    expect(isNativeProxyPath("/cerebrum-native")).toBe(true);
    expect(isNativeProxyPath("/cerebrum-native-assets/app.js")).toBe(false);
  });

  test("preserves native path and query while replacing the shell origin", () => {
    expect(
      buildNativeProxyUrl("ardor://app/cerebrum-native/threads?workspace=workspace-1", "https://api.example"),
    ).toBe("https://api.example/cerebrum-native/threads?workspace=workspace-1");
  });

  test("uses the channel default when a packaged runtime has no process env", () => {
    expect(resolveNativeApiOrigin(undefined, "stage1")).toBe("https://azure-stage.dev.ardor.cloud");
    expect(resolveNativeApiOrigin(undefined, "prod")).toBe("https://console.ardor.cloud");
  });

  test("removes shell-only headers but keeps authorization and workspace context", () => {
    const headers = sanitizeNativeProxyHeaders({
      Authorization: "Bearer token",
      Cookie: "shell-cookie",
      Host: "app",
      Origin: "ardor://app",
      Referer: "ardor://app/agent",
      "X-Workspace-ID": "workspace-1",
    }, 'https://api.example');

    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("X-Workspace-ID")).toBe("workspace-1");
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("Origin")).toBe("https://api.example");
  });
});
