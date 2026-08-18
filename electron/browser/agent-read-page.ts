import type { BrowserTabHandle } from "./browser-surface";

export interface BrowserAgentPageElement {
  ref: string;
  role: string;
  name?: string;
  text?: string;
  href?: string;
  type?: string;
  value?: string;
}

export interface BrowserAgentPageSnapshot {
  url: string;
  title: string;
  elements: BrowserAgentPageElement[];
  truncated: boolean;
}

const READ_PAGE_EXPRESSION = String.raw`(() => {
  const MAX_ELEMENTS = 500;
  const MAX_TEXT = 300;
  const MAX_TOTAL_TEXT = 60000;
  const root = globalThis;
  const pageKey = location.href;
  let state = root.__ardorBrowserAgentState;
  if (!state || state.pageKey !== pageKey || !state.elements) {
    state = { pageKey, nextRef: 1, refs: new WeakMap(), elements: new Map() };
    root.__ardorBrowserAgentState = state;
  }

  const clean = (value, limit = MAX_TEXT) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const sensitive = (element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
      return false;
    }
    const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
    const autocomplete = clean(element.getAttribute("autocomplete"), 100).toLowerCase();
    return type === "password" || type === "hidden" || [
      "current-password", "new-password", "one-time-code", "cc-number", "cc-csc",
      "cc-exp", "cc-exp-month", "cc-exp-year"
    ].includes(autocomplete);
  };
  const roleFor = (element) => {
    const explicit = clean(element.getAttribute("role"), 60);
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "img") return "img";
    if (tag === "li") return "listitem";
    if (tag === "input") {
      const type = element.type.toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(type)) return "button";
      return "textbox";
    }
    return tag;
  };
  const nameFor = (element) => {
    const ariaLabel = clean(element.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = clean(element.getAttribute("aria-labelledby"), 200);
    if (labelledBy) {
      const label = clean(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
      if (label) return label;
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      const label = clean(element.labels ? Array.from(element.labels).map((item) => item.textContent || "").join(" ") : "");
      if (label) return label;
      const placeholder = clean(element.getAttribute("placeholder"));
      if (placeholder) return placeholder;
    }
    return clean(element.getAttribute("alt") || element.getAttribute("title") || element.textContent);
  };
  const safeHref = (element) => {
    if (!(element instanceof HTMLAnchorElement) || !element.href) return undefined;
    try {
      const url = new URL(element.href);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
      return url.toString().slice(0, 2048);
    } catch {
      return undefined;
    }
  };
  const refFor = (element) => {
    let ref = state.refs.get(element);
    if (!ref) {
      ref = "ref_" + state.nextRef++;
      state.refs.set(element, ref);
    }
    state.elements.set(ref, element);
    return ref;
  };

  const selector = [
    "a[href]", "button", "input", "select", "textarea", "summary", "[contenteditable=true]",
    "[role]", "[tabindex]", "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "label", "td", "th"
  ].join(",");
  const elements = [];
  let totalText = 0;
  let truncated = false;
  for (const element of document.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS || totalText >= MAX_TOTAL_TEXT) {
      truncated = true;
      break;
    }
    if (!(element instanceof HTMLElement) || !visible(element)) continue;
    const role = roleFor(element);
    const name = nameFor(element);
    const text = clean(element.innerText);
    const entry = { ref: refFor(element), role };
    if (name) entry.name = name;
    if (text && text !== name) entry.text = text;
    const href = safeHref(element);
    if (href) entry.href = href;
    if (element instanceof HTMLInputElement) entry.type = element.type;
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      const value = sensitive(element) ? "[value redacted]" : clean(element.value);
      if (value) entry.value = value;
    }
    totalText += JSON.stringify(entry).length;
    elements.push(entry);
  }
  return {
    url: location.href,
    title: clean(document.title, 512),
    elements,
    truncated
  };
})()`;

interface FrameTreeResponse {
  frameTree?: { frame?: { id?: unknown } };
}

interface IsolatedWorldResponse {
  executionContextId?: unknown;
}

interface RuntimeEvaluationResponse {
  exceptionDetails?: unknown;
  result?: { value?: unknown };
}

export async function evaluateInBrowserAgentWorld(handle: BrowserTabHandle, expression: string): Promise<unknown> {
  const contextId = await getBrowserAgentExecutionContext(handle);
  const evaluation = (await handle.sendCommand("Runtime.evaluate", {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true,
    timeout: 5_000,
    userGesture: false,
  })) as RuntimeEvaluationResponse;
  if (evaluation.exceptionDetails) {
    throw new Error("Browser page command failed");
  }
  return evaluation.result?.value;
}

async function getBrowserAgentExecutionContext(handle: BrowserTabHandle): Promise<number> {
  const frameTree = (await handle.sendCommand("Page.getFrameTree")) as FrameTreeResponse;
  const frameId = frameTree.frameTree?.frame?.id;
  if (typeof frameId !== "string" || !frameId) {
    throw new Error("Browser page main frame is unavailable");
  }
  const isolatedWorld = (await handle.sendCommand("Page.createIsolatedWorld", {
    frameId,
    grantUniveralAccess: false,
    worldName: "ardor-browser-agent-v1",
  })) as IsolatedWorldResponse;
  if (!Number.isInteger(isolatedWorld.executionContextId)) {
    throw new Error("Browser page isolated world is unavailable");
  }
  return isolatedWorld.executionContextId as number;
}

export async function readBrowserPage(handle: BrowserTabHandle): Promise<BrowserAgentPageSnapshot> {
  const value = await evaluateInBrowserAgentWorld(handle, READ_PAGE_EXPRESSION);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser page returned an invalid snapshot");
  }
  const snapshot = value as Partial<BrowserAgentPageSnapshot>;
  if (
    typeof snapshot.url !== "string" ||
    typeof snapshot.title !== "string" ||
    !Array.isArray(snapshot.elements) ||
    typeof snapshot.truncated !== "boolean"
  ) {
    throw new Error("Browser page returned an invalid snapshot");
  }
  return snapshot as BrowserAgentPageSnapshot;
}
