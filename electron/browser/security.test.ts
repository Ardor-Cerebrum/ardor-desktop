import { describe, expect, test } from "bun:test";

import {
  BROWSER_TOOL_METHODS,
  isAllowedBrowserOrigin,
  isBrowserToolMethod,
  isPublicBrowserUrl,
  requiresBrowserConfirmation,
  truncateBrowserPayload,
  validateBrowserAutomationRequest,
} from "./security";

describe("browser security policy", () => {
  test("grants access only to the explicitly approved origin", () => {
    expect(isAllowedBrowserOrigin("https://example.com/login", ["https://example.com"])).toBe(true);
    expect(isAllowedBrowserOrigin("https://evil.example.com/login", ["https://example.com"])).toBe(false);
    expect(isAllowedBrowserOrigin("file:///etc/passwd", ["https://example.com"])).toBe(false);
  });

  test("accepts only public HTTPS browser targets", () => {
    expect(isPublicBrowserUrl("https://example.com/path")).toBe(true);
    expect(isPublicBrowserUrl("http://example.com/path")).toBe(false);
    expect(isPublicBrowserUrl("https://localhost/path")).toBe(false);
    expect(isPublicBrowserUrl("https://127.0.0.1/path")).toBe(false);
    expect(isPublicBrowserUrl("https://10.0.0.1/path")).toBe(false);
    expect(isPublicBrowserUrl("https://user:pass@example.com/path")).toBe(false);
  });

  test("keeps CDP methods on the browser tool allowlist", () => {
    expect(isBrowserToolMethod("DOM.getDocument")).toBe(true);
    expect(isBrowserToolMethod("Browser.grantPermissions")).toBe(false);
    expect(BROWSER_TOOL_METHODS).toContain("Runtime.evaluate");
  });

  test("bounds page-scoped Runtime.evaluate and rejects privileged parameters", () => {
    expect(validateBrowserAutomationRequest("Runtime.evaluate", { expression: "document.title" })).toEqual({
      expression: "document.title",
      awaitPromise: true,
      returnByValue: true,
      timeout: 5_000,
      userGesture: false,
    });
    expect(() => validateBrowserAutomationRequest("Runtime.evaluate", { expression: "" })).toThrow();
    expect(() =>
      validateBrowserAutomationRequest("Runtime.evaluate", { expression: "document.title", contextId: 1 }),
    ).toThrow("contextId");
    expect(() =>
      validateBrowserAutomationRequest("Runtime.evaluate", { expression: "x".repeat(32 * 1024 + 1) }),
    ).toThrow();
  });

  test("requires confirmation for credential and external actions", () => {
    expect(requiresBrowserConfirmation("read")).toBe(false);
    expect(requiresBrowserConfirmation("credential-fill")).toBe(true);
    expect(requiresBrowserConfirmation("open-external")).toBe(true);
  });

  test("bounds result payloads without returning partial UTF-8 text", () => {
    const result = truncateBrowserPayload({ text: "x".repeat(20) }, 10);
    expect(result.truncated).toBe(true);
    expect(result.value).toBe("{\"text\":\"x");
    expect(truncateBrowserPayload({ ok: true }, 100)).toEqual({
      truncated: false,
      value: "{\"ok\":true}",
    });
  });
});
