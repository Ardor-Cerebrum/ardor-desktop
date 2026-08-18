import type { BrowserTabHandle } from "./browser-surface";

export interface BrowserAgentPageSnapshot {
  content: string;
  fullLength: number;
  truncated: boolean;
  viewport: { height: number; width: number };
}

export interface BrowserAgentReadPageOptions {
  depth?: number;
  filter?: "all" | "interactive";
  maxChars?: number;
  refId?: string;
}

interface FrameTreeResponse {
  frameTree?: { frame?: { id?: unknown } };
}

interface IsolatedWorldResponse {
  executionContextId?: unknown;
}

interface RuntimeEvaluationResponse {
  exceptionDetails?: { text?: unknown };
  result?: { description?: unknown; value?: unknown };
}

const MAX_TREE_DEPTH = 50;
const MAX_TREE_NODES = 10_000;
const MAX_TREE_CHARS = 200_000;
const DEFAULT_TREE_DEPTH = 15;
const DEFAULT_TREE_CHARS = 50_000;
const MAX_PAGE_TEXT_CHARS = 200_000;

const READ_PAGE_FUNCTION = String.raw`(options) => {
  const root = globalThis;
  const pageKey = location.href;
  let state = root.__ardorBrowserAgentState;
  if (!state || state.pageKey !== pageKey || !state.elements) {
    state = { pageKey, nextRef: 1, refs: new WeakMap(), elements: new Map(), searchEntries: [] };
    root.__ardorBrowserAgentState = state;
  }
  const previousElements = state.elements;
  const nextElements = new Map();
  state.searchEntries = [];

  const clean = (value, limit = 1000) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const quote = (value) => JSON.stringify(clean(value));
  const safeHttpUrl = (value) => {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      url.username = "";
      url.password = "";
      return url.toString();
    } catch {
      return null;
    }
  };
  const safeLocation = safeHttpUrl(location.href) || location.origin;
  const hidden = (element) => {
    if (element.getAttribute("aria-hidden") === "true" || element.hidden) return true;
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
      element.getBoundingClientRect().width <= 0 || element.getBoundingClientRect().height <= 0;
  };
  const interactive = (element) => {
    const tag = element.tagName.toLowerCase();
    const role = clean(element.getAttribute("role"), 80).toLowerCase();
    return ["a", "button", "input", "select", "textarea", "summary", "details"].includes(tag) ||
      element.isContentEditable || element.hasAttribute("onclick") || element.hasAttribute("tabindex") ||
      ["button", "checkbox", "combobox", "link", "menuitem", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"].includes(role);
  };
  const roleFor = (element) => {
    const explicit = clean(element.getAttribute("role"), 80);
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea" || element.isContentEditable) return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (tag === "li") return "listitem";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "section") return "region";
    if (tag === "article") return "article";
    if (tag === "aside") return "complementary";
    if (tag === "form") return "form";
    if (tag === "table") return "table";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "input") {
      const type = String(element.type || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(type)) return "button";
      if (type === "range") return "slider";
      return "textbox";
    }
    return tag;
  };
  const nameFor = (element) => {
    const ariaLabel = clean(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = clean(element.getAttribute("aria-labelledby"), 300);
    if (labelledBy) {
      const label = clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
      if (label) return label;
    }
    if (element.labels) {
      const label = clean(Array.from(element.labels).map((item) => item.textContent || "").join(" "));
      if (label) return label;
    }
    return clean(element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") || "");
  };
  const sensitive = (element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return false;
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
    const autocomplete = clean(element.getAttribute("autocomplete"), 100).toLowerCase();
    return type === "password" || type === "hidden" || [
      "current-password", "new-password", "one-time-code", "cc-number", "cc-csc",
      "cc-exp", "cc-exp-month", "cc-exp-year"
    ].includes(autocomplete);
  };
  const refFor = (element) => {
    let ref = state.refs.get(element);
    if (!ref) {
      ref = "ref_" + state.nextRef++;
      state.refs.set(element, ref);
    }
    nextElements.set(ref, element);
    return ref;
  };
  const attributesFor = (element) => {
    const attrs = [];
    const name = nameFor(element);
    if (name) attrs.push("name=" + quote(name));
    if (element instanceof HTMLInputElement) attrs.push("type=" + quote(element.type || "text"));
    const placeholder = clean(element.getAttribute("placeholder"));
    if (placeholder && placeholder !== name) attrs.push("placeholder=" + quote(placeholder));
    if (element instanceof HTMLAnchorElement && element.href) {
      const href = safeHttpUrl(element.href);
      if (href) attrs.push("href=" + quote(href.slice(0, 2048)));
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const value = sensitive(element) ? "[value redacted]" : clean(element.value, 500);
      if (value) attrs.push("value=" + quote(value));
      if ("checked" in element && element.checked) attrs.push("checked=true");
      if (element.disabled) attrs.push("disabled=true");
    }
    return attrs;
  };

  let start = document.body || document.documentElement;
  if (options.refId) {
    start = previousElements.get(options.refId);
    if (!(start instanceof Element) || !start.isConnected) {
      return { error: "Element ref not found or stale; call read_page without ref_id" };
    }
  }
  const lines = ["- document " + quote(document.title || safeLocation) + " [url=" + quote(safeLocation) + "]"];
  let nodes = 0;
  let nodeLimitReached = false;
  const visit = (element, depth) => {
    if (!(element instanceof Element) || depth > options.depth || nodes >= ${MAX_TREE_NODES}) {
      if (nodes >= ${MAX_TREE_NODES}) nodeLimitReached = true;
      return;
    }
    const tag = element.tagName.toLowerCase();
    if (["script", "style", "meta", "link", "title", "noscript"].includes(tag)) return;
    if (options.filter !== "all") {
      if (hidden(element)) return;
      if (!options.refId) {
        const rect = element.getBoundingClientRect();
        if (rect.top >= innerHeight || rect.bottom <= 0 || rect.left >= innerWidth || rect.right <= 0) return;
      }
    }
    const isInteractive = interactive(element);
    const role = roleFor(element);
    const directText = clean(Array.from(element.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent || "")
      .join(" "), 1000);
    const meaningfulText = directText.length >= 3 ? directText : "";
    const semantic = isInteractive || /^(heading|image|img|list|listitem|navigation|banner|contentinfo|region|article|main|table|p|td|th|label|form)$/.test(role) || meaningfulText;
    let emittedDepth = depth;
    const forceTarget = Boolean(options.refId) && depth === 0;
    if ((semantic && (options.filter !== "interactive" || isInteractive)) || forceTarget) {
      nodes += 1;
      const ref = refFor(element);
      const attrs = attributesFor(element);
      const suffix = ["[" + ref + "]", attrs.length ? "[" + attrs.join(" ") + "]" : "", meaningfulText ? quote(meaningfulText) : ""]
        .filter(Boolean).join(" ");
      const line = "  ".repeat(Math.max(1, depth + 1)) + "- " + role + (suffix ? " " + suffix : "");
      lines.push(line);
      state.searchEntries.push({ ref, text: clean([role, nameFor(element), meaningfulText, attrs.join(" ")].join(" "), 3000), line });
      if (element instanceof HTMLSelectElement && !sensitive(element)) {
        for (const option of element.options) {
          const label = clean(option.textContent, 100);
          const value = clean(option.value, 100);
          const optionAttrs = [option.selected ? "selected" : "", value && value !== label ? "value=" + quote(value) : ""]
            .filter(Boolean).join(" ");
          lines.push("  ".repeat(Math.max(1, depth + 2)) + "- option" + (label ? " " + quote(label) : "") + (optionAttrs ? " [" + optionAttrs + "]" : ""));
        }
      }
    } else if (!semantic) {
      emittedDepth = depth - 1;
    }
    if (element instanceof HTMLSelectElement && sensitive(element)) return;
    for (const child of element.children) visit(child, emittedDepth + 1);
  };
  visit(start, 0);
  state.elements = nextElements;
  let content = lines.join("\n");
  const fullLength = content.length;
  const truncated = nodeLimitReached || content.length > options.maxChars;
  if (content.length > options.maxChars) {
    const cut = content.lastIndexOf("\n", options.maxChars);
    content = content.slice(0, cut > 0 ? cut : options.maxChars);
  }
  if (truncated) content += "\n[tree truncated; full size " + fullLength + " chars]";
  return { content, fullLength, truncated, viewport: { height: innerHeight, width: innerWidth } };
}`;

const FIND_FUNCTION = String.raw`(query) => {
  const state = globalThis.__ardorBrowserAgentState;
  if (!state || state.pageKey !== location.href || !Array.isArray(state.searchEntries)) {
    return { error: "No read_page tree is cached; call read_page first" };
  }
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return { error: "Find query is empty" };
  const matches = state.searchEntries.filter((entry) => entry.text.toLowerCase().includes(needle));
  return {
    content: matches.slice(0, 20).map((entry) => entry.line).join("\n") || "No matching elements found",
    matchCount: matches.length,
    truncated: matches.length > 20
  };
}`;

const PAGE_TEXT_FUNCTION = String.raw`(maxChars) => {
  const candidates = [document.querySelector("article"), document.querySelector("main"), document.querySelector('[role="main"]'), document.body];
  const target = candidates.find((item) => item instanceof HTMLElement);
  const text = String(target?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  return { content: text.slice(0, maxChars), fullLength: text.length, truncated: text.length > maxChars };
}`;

const FORM_INPUT_FUNCTION = String.raw`({ref, value}) => {
  const element = globalThis.__ardorBrowserAgentState?.elements?.get(ref);
  if (!(element instanceof HTMLElement) || !element.isConnected) return { error: "Element ref is stale; call read_page again" };
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus();
  if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set?.call(element, Boolean(value));
  } else if (element instanceof HTMLInputElement) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, String(value));
  } else if (element instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, String(value));
  } else if (element instanceof HTMLSelectElement) {
    const requested = String(value);
    const option = Array.from(element.options).find((item) => item.value === requested || item.text === requested);
    if (!option) return { error: "Select option was not found" };
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(element, option.value);
  } else if (element.isContentEditable) {
    element.textContent = String(value);
  } else {
    return { error: "Element does not support form_input" };
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: typeof value === "string" ? value : null }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true };
}`;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("Browser page limit is invalid");
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function functionCall(source: string, argument: unknown): string {
  return `(${source})(${JSON.stringify(argument)})`;
}

export async function evaluateInBrowserAgentWorld(handle: BrowserTabHandle, expression: string): Promise<unknown> {
  const contextId = await getBrowserAgentExecutionContext(handle);
  return evaluate(handle, expression, contextId);
}

export async function evaluateInBrowserPage(handle: BrowserTabHandle, expression: string): Promise<unknown> {
  return evaluate(handle, expression);
}

async function evaluate(handle: BrowserTabHandle, expression: string, contextId?: number): Promise<unknown> {
  const evaluation = (await handle.sendCommand("Runtime.evaluate", {
    expression,
    ...(contextId === undefined ? {} : { contextId }),
    awaitPromise: true,
    returnByValue: true,
    timeout: 10_000,
    userGesture: false,
  })) as RuntimeEvaluationResponse;
  if (evaluation.exceptionDetails) {
    const description = evaluation.result?.description;
    throw new Error(typeof description === "string" ? description.slice(0, 2_000) : "Browser page command failed");
  }
  return evaluation.result?.value;
}

async function getBrowserAgentExecutionContext(handle: BrowserTabHandle): Promise<number> {
  const frameTree = (await handle.sendCommand("Page.getFrameTree")) as FrameTreeResponse;
  const frameId = frameTree.frameTree?.frame?.id;
  if (typeof frameId !== "string" || !frameId) throw new Error("Browser page main frame is unavailable");
  const isolatedWorld = (await handle.sendCommand("Page.createIsolatedWorld", {
    frameId,
    grantUniveralAccess: false,
    worldName: "ardor-browser-agent-v1",
  })) as IsolatedWorldResponse;
  if (!Number.isInteger(isolatedWorld.executionContextId)) throw new Error("Browser page isolated world is unavailable");
  return isolatedWorld.executionContextId as number;
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const object = value as Record<string, unknown>;
  if (typeof object.error === "string") throw new Error(object.error);
  return object;
}

export async function readBrowserPage(
  handle: BrowserTabHandle,
  options: BrowserAgentReadPageOptions = {},
): Promise<BrowserAgentPageSnapshot> {
  const normalized = {
    depth: boundedInteger(options.depth, DEFAULT_TREE_DEPTH, 1, MAX_TREE_DEPTH),
    filter: options.filter ?? "all",
    maxChars: boundedInteger(options.maxChars, DEFAULT_TREE_CHARS, 1_000, MAX_TREE_CHARS),
    refId: options.refId,
  };
  const value = requireObject(
    await evaluateInBrowserAgentWorld(handle, functionCall(READ_PAGE_FUNCTION, normalized)),
    "Browser page returned an invalid snapshot",
  );
  const viewport = value.viewport;
  if (
    typeof value.content !== "string" ||
    typeof value.fullLength !== "number" ||
    typeof value.truncated !== "boolean" ||
    !viewport ||
    typeof viewport !== "object" ||
    Array.isArray(viewport) ||
    typeof (viewport as Record<string, unknown>).height !== "number" ||
    typeof (viewport as Record<string, unknown>).width !== "number"
  ) {
    throw new Error("Browser page returned an invalid snapshot");
  }
  return value as unknown as BrowserAgentPageSnapshot;
}

export async function findInBrowserPage(handle: BrowserTabHandle, query: string): Promise<Record<string, unknown>> {
  return requireObject(
    await evaluateInBrowserAgentWorld(handle, functionCall(FIND_FUNCTION, query)),
    "Browser page returned an invalid find result",
  );
}

export async function getBrowserPageText(handle: BrowserTabHandle, maxChars?: number): Promise<Record<string, unknown>> {
  const limit = boundedInteger(maxChars, DEFAULT_TREE_CHARS, 1_000, MAX_PAGE_TEXT_CHARS);
  return requireObject(
    await evaluateInBrowserAgentWorld(handle, functionCall(PAGE_TEXT_FUNCTION, limit)),
    "Browser page returned invalid text content",
  );
}

export async function setBrowserFormInput(
  handle: BrowserTabHandle,
  ref: string,
  value: string | number | boolean,
): Promise<void> {
  const result = requireObject(
    await evaluateInBrowserAgentWorld(handle, functionCall(FORM_INPUT_FUNCTION, { ref, value })),
    "Browser form input failed",
  );
  if (result.ok !== true) throw new Error("Browser form input failed");
}
