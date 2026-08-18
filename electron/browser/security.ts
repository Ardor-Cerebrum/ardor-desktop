import { isIP } from "node:net";

export const BROWSER_TOOL_METHODS = [
  "Accessibility.getFullAXTree",
  "CSS.getComputedStyleForNode",
  "DOM.describeNode",
  "DOM.disable",
  "DOM.enable",
  "DOM.focus",
  "DOM.getAttributes",
  "DOM.getBoxModel",
  "DOM.getDocument",
  "DOM.getOuterHTML",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOMSnapshot.captureSnapshot",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Performance.getMetrics",
  "Runtime.evaluate",
] as const;

export type BrowserToolMethod = (typeof BROWSER_TOOL_METHODS)[number];

const browserToolMethodSet = new Set<string>(BROWSER_TOOL_METHODS);

export function isBrowserToolMethod(value: string): value is BrowserToolMethod {
  return browserToolMethodSet.has(value);
}

const MAX_AUTOMATION_REQUEST_BYTES = 64 * 1024;
const MAX_RUNTIME_EVALUATE_BYTES = 32 * 1024;
export const DEFAULT_BROWSER_AUTOMATION_RESULT_BYTES = 256 * 1024;
const RUNTIME_EVALUATE_FORBIDDEN_PARAMETERS = [
  "allowUnsafeEvalBlockedByCSP",
  "contextId",
  "includeCommandLineAPI",
  "objectGroup",
  "serializationOptions",
  "uniqueContextId",
] as const;

export function validateBrowserAutomationRequest(
  method: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("browser automation params must be an object");
  }
  if (!isBrowserToolMethod(method)) {
    throw new Error("browser automation method is not allowed");
  }

  let normalizedParams = { ...params };
  if (method === "Runtime.evaluate") {
    const expression = normalizedParams.expression;
    if (typeof expression !== "string" || expression.length === 0) {
      throw new Error("Runtime.evaluate requires a string expression");
    }
    if (new TextEncoder().encode(expression).byteLength > MAX_RUNTIME_EVALUATE_BYTES) {
      throw new Error("Runtime.evaluate expression must contain at most 32768 bytes");
    }
    for (const forbidden of RUNTIME_EVALUATE_FORBIDDEN_PARAMETERS) {
      if (forbidden in normalizedParams) {
        throw new Error(`Runtime.evaluate parameter ${forbidden} is not allowed`);
      }
    }
    normalizedParams = {
      ...normalizedParams,
      awaitPromise: true,
      returnByValue: true,
      timeout: 5_000,
      userGesture: false,
    };
  }

  const serialized = JSON.stringify({ method, params: normalizedParams });
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUTOMATION_REQUEST_BYTES) {
    throw new Error("browser automation request is too large");
  }
  return normalizedParams;
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isPublicIpv4(host: string): boolean {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPublicIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return false;
  }
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return false;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPublicIpv4(normalized.slice("::ffff:".length));
  }
  return true;
}

export function isLoopbackBrowserUrl(url: URL): boolean {
  const host = url.hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return url.protocol === "http:" || url.protocol === "https:";
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    return host.startsWith("127.");
  }
  return ipVersion === 6 && (host === "::1" || host === "0:0:0:0:0:0:0:1");
}

export function isBrowserNavigableUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (isLoopbackBrowserUrl(url)) {
    return true;
  }
  if (url.protocol !== "https:") {
    return false;
  }

  // Credentials are part of the page URL, not the destination policy. Validate
  // the underlying protocol and host without stripping them from navigation.
  url.username = "";
  url.password = "";
  return isPublicBrowserUrl(url.toString());
}

export function normalizeBrowserNavigationUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (isLoopbackBrowserUrl(url)) {
    return url.toString();
  }
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }
  return isBrowserNavigableUrl(url.toString()) ? url.toString() : null;
}

export function isPublicBrowserUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return false;
  }
  const host = url.hostname.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPublicIpv4(host);
  if (ipVersion === 6) return isPublicIpv6(host);
  return true;
}

export function isAllowedBrowserOrigin(value: string, allowedOrigins: readonly string[]): boolean {
  const origin = normalizeOrigin(value);
  if (!origin) {
    return false;
  }
  return allowedOrigins.some((allowedOrigin) => normalizeOrigin(allowedOrigin) === origin);
}

export type BrowserSensitiveAction =
  | "read"
  | "input"
  | "navigate"
  | "download"
  | "credential-fill"
  | "open-external";

export function requiresBrowserConfirmation(action: BrowserSensitiveAction): boolean {
  return action === "download" || action === "credential-fill" || action === "open-external";
}

export interface TruncatedBrowserPayload {
  truncated: boolean;
  value: string;
}

export interface NormalizedBrowserAutomationResult {
  generation: number;
  result: Record<string, unknown>;
}

export function truncateBrowserPayload(value: unknown, maxBytes: number): TruncatedBrowserPayload {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const serialized = JSON.stringify(value) ?? "null";
  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return { truncated: false, value: serialized };
  }

  let end = maxBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      decoder.decode(bytes.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }
  return { truncated: true, value: bytes.subarray(0, end).toString("utf8") };
}

export function normalizeBrowserAutomationResult(
  generation: number,
  rawResult: unknown,
  maxBytes: number,
): NormalizedBrowserAutomationResult {
  const commandResult =
    rawResult && typeof rawResult === "object" && "result" in rawResult
      ? (rawResult as { result: unknown }).result
      : rawResult;
  const bounded = truncateBrowserPayload(commandResult, maxBytes);
  if (bounded.truncated) {
    return { generation, result: { truncated: true, value: bounded.value } };
  }

  const parsed = JSON.parse(bounded.value) as unknown;
  return {
    generation,
    result:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed },
  };
}
