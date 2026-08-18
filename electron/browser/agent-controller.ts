import type {
  BrowserAgentCommand,
  BrowserAgentExecutionResult,
  BrowserAgentToolName,
  BrowserPaneViewport,
} from "../bridge-contract";
import {
  captureBrowserAgentScreenshot,
  dispatchBrowserClick,
  dispatchBrowserDrag,
  dispatchBrowserHover,
  dispatchBrowserKeys,
  dispatchBrowserScroll,
  dispatchBrowserText,
  focusBrowserElement,
  parseModifierBits,
  resolveBrowserElementPoint,
  scrollBrowserElementIntoView,
  type BrowserAgentPoint,
  type BrowserAgentScreenshot,
} from "./agent-page-actions";
import {
  evaluateInBrowserPage,
  findInBrowserPage,
  getBrowserPageText,
  readBrowserPage,
  setBrowserFormInput,
} from "./agent-read-page";
import type { BrowserAgentTabTarget, BrowserPaneController } from "./pane-controller";
import { normalizeBrowserNavigationUrl } from "./security";

const ID_PATTERN = /^[a-zA-Z0-9:_./-]{1,256}$/;
const REF_PATTERN = /^ref_[1-9][0-9]{0,7}$/;
const MAX_TOOL_TEXT_BYTES = 100 * 1024;
const TOOL_TIMEOUT_MS = 30_000;
const MAX_TABS = 9;
interface BrowserAgentBinding {
  actionOrigins: Set<string>;
  activeContextId: string;
  contextIds: string[];
  readOrigins: Set<string>;
}

interface BoundBrowserAgentTarget extends BrowserAgentTabTarget {
  contextId: string;
}

export interface BrowserAgentControllerOptions {
  authorizeCredentialNavigation: (input: { origin: string; sessionId: string }) => Promise<boolean>;
  authorizeOrigin: (input: {
    access: "action" | "read";
    origin: string;
    sessionId: string;
    tool: string;
  }) => Promise<"deny" | "once" | "session">;
}

function browserOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function browserSafeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
  } catch {
    return false;
  }
}

function normalizeAgentNavigationUrl(value: string, currentUrl: string): string | null {
  const input = value.trim();
  if (!input) return null;
  if (input.startsWith("/")) {
    try {
      return normalizeBrowserNavigationUrl(new URL(input, currentUrl).toString());
    } catch {
      return null;
    }
  }
  const loopback = /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::\d+)?(?:[/#?]|$)/i.test(input);
  const hasScheme = !loopback && /^[a-z][a-z0-9+.-]*:/i.test(input);
  return normalizeBrowserNavigationUrl(hasScheme ? input : `${loopback ? "http" : "https"}://${input}`);
}

function objectInput(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser tool input is invalid");
  return value as Record<string, unknown>;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Browser tool ${key} is invalid`);
  return value;
}

function requiredString(input: Record<string, unknown>, key: string, maxBytes = MAX_TOOL_TEXT_BYTES): string {
  const value = optionalString(input, key);
  if (value === undefined || !value || new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new Error(`Browser tool ${key} is missing or too large`);
  }
  return value;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Browser tool ${key} is invalid`);
  return value;
}

function pointInput(value: unknown, label: string): BrowserAgentPoint {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error(`Browser ${label} coordinate is invalid`);
  }
  return { x: value[0], y: value[1] };
}

async function withTimeout<T>(operation: Promise<T>, milliseconds = TOOL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Browser tool timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BrowserAgentController {
  private readonly bindings = new Map<string, BrowserAgentBinding>();
  private readonly screenshots = new Map<string, BrowserAgentScreenshot & { navigationEpoch: number }>();

  constructor(
    private readonly panes: BrowserPaneController,
    private readonly options: BrowserAgentControllerOptions,
  ) {}

  bind(sessionId: string, contextId: string): boolean {
    this.assertId(sessionId, "session");
    this.assertId(contextId, "context");
    const existing = this.bindings.get(sessionId);
    if (existing) {
      if (!existing.contextIds.includes(contextId)) existing.contextIds.push(contextId);
      existing.activeContextId = contextId;
      return true;
    }
    this.bindings.set(sessionId, {
      actionOrigins: new Set(),
      activeContextId: contextId,
      contextIds: [contextId],
      readOrigins: new Set(),
    });
    return true;
  }

  unbind(sessionId: string, contextId: string): boolean {
    this.assertId(sessionId, "session");
    this.assertId(contextId, "context");
    const binding = this.bindings.get(sessionId);
    if (!binding || !binding.contextIds.includes(contextId)) return false;
    binding.contextIds = binding.contextIds.filter((candidate) => candidate !== contextId);
    for (const key of this.screenshots.keys()) if (key.startsWith(`${contextId}\0`)) this.screenshots.delete(key);
    if (binding.contextIds.length === 0) this.bindings.delete(sessionId);
    else if (binding.activeContextId === contextId) binding.activeContextId = binding.contextIds.at(-1) as string;
    return true;
  }

  async execute(sessionId: string, command: BrowserAgentCommand): Promise<BrowserAgentExecutionResult> {
    try {
      return await withTimeout(this.executeCommand(sessionId, command));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Browser agent command failed" };
    }
  }

  dispose(): void {
    this.bindings.clear();
    this.screenshots.clear();
  }

  private async executeCommand(sessionId: string, command: BrowserAgentCommand): Promise<BrowserAgentExecutionResult> {
    this.assertId(sessionId, "session");
    const binding = this.bindings.get(sessionId);
    if (!binding) throw new Error("No Browser tile is attached to this chat session; open a Browser tile first");
    const input = objectInput(command.input);
    let result: Record<string, unknown>;
    switch (command.name) {
      case "preview_start":
        result = await this.previewStart(sessionId, binding, input);
        break;
      case "preview_stop":
      case "preview_logs":
        throw new Error("No local dev-server process belongs to this cloud agent session; use preview_start with a URL");
      case "preview_list":
        result = { processes: [], previewId: sessionId, ...this.tabsContext(binding) };
        break;
      case "tabs_context":
        result = this.tabsContext(binding);
        break;
      case "tabs_create":
        result = await this.tabsCreate(binding);
        break;
      case "tabs_select":
        result = this.tabsSelect(binding, requiredString(input, "tabId", 256));
        break;
      case "tabs_close":
        result = await this.tabsClose(binding, requiredString(input, "tabId", 256));
        break;
      case "read_page":
        result = await this.readPage(sessionId, binding, input);
        break;
      case "find":
        result = await this.find(sessionId, binding, input);
        break;
      case "get_page_text":
        result = await this.getPageText(sessionId, binding, input);
        break;
      case "navigate":
        result = await this.navigate(sessionId, binding, input);
        break;
      case "computer":
        result = await this.computer(sessionId, binding, input);
        break;
      case "form_input":
        result = await this.formInput(sessionId, binding, input);
        break;
      case "javascript_tool":
        result = await this.javascriptTool(sessionId, binding, input);
        break;
      case "read_console_messages":
        result = await this.readConsole(sessionId, binding, input);
        break;
      case "read_network_requests":
        result = await this.readNetwork(sessionId, binding, input);
        break;
      case "resize_window":
        result = await this.resizeWindow(sessionId, binding, input);
        break;
      default:
        throw new Error("Browser agent command is not supported");
    }
    return { ok: true, result };
  }

  private tabsContext(binding: BrowserAgentBinding): Record<string, unknown> {
    const snapshots = binding.contextIds.flatMap((contextId) => {
      const snapshot = this.panes.getState(contextId);
      return snapshot ? [snapshot] : [];
    });
    if (snapshots.length === 0) throw new Error("The attached Browser tiles are unavailable");
    const activeSnapshot = snapshots.find((snapshot) => snapshot.contextId === binding.activeContextId) ?? snapshots[0];
    return {
      tabs: snapshots.flatMap((snapshot) =>
        snapshot.tabs.map((tab) => ({
          isActive: snapshot.contextId === activeSnapshot.contextId && tab.active,
          origin: browserOrigin(tab.url),
          tabId: tab.id,
        })),
      ),
    };
  }

  private async previewStart(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (optionalString(input, "name")) {
      throw new Error("Named preview servers require a local project runtime; this session is cloud-hosted. Start the server with the agent shell and pass its reachable URL to preview_start");
    }
    const url = requiredString(input, "url", 8_192);
    const created = await this.tabsCreate(binding);
    const tabId = created.tabId as string;
    let navigation: Record<string, unknown>;
    try {
      navigation = await this.navigate(sessionId, binding, { tabId, url });
    } catch (error) {
      const target = this.resolveTarget(binding, tabId);
      await this.panes.closeTab(target.contextId, tabId);
      throw error;
    }
    return { previewId: sessionId, serverId: null, tabId, url: navigation.url };
  }

  private async tabsCreate(binding: BrowserAgentBinding): Promise<Record<string, unknown>> {
    const context = this.panes.getState(binding.activeContextId);
    if (!context) throw new Error("The active Browser tile is unavailable");
    if (context.tabs.length >= MAX_TABS) throw new Error("Browser tab limit reached; close a tab before creating another");
    const snapshot = await this.panes.createTab(binding.activeContextId);
    return { tabId: snapshot.activeTabId, ...this.tabsContext(binding) };
  }

  private tabsSelect(binding: BrowserAgentBinding, tabId: string): Record<string, unknown> {
    const target = this.resolveTarget(binding, tabId);
    binding.activeContextId = target.contextId;
    this.panes.selectTab(target.contextId, target.id);
    return this.tabsContext(binding);
  }

  private async tabsClose(binding: BrowserAgentBinding, tabId: string): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, tabId);
    const snapshot = this.panes.getState(target.contextId);
    if (!snapshot || snapshot.tabs.length <= 1) throw new Error("The last Browser tab cannot be closed from a tool");
    await this.panes.closeTab(target.contextId, target.id);
    this.screenshots.delete(this.screenshotKey(target));
    return this.tabsContext(binding);
  }

  private async readPage(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "read_page", "read", target);
    const filter = optionalString(input, "filter");
    if (filter !== undefined && filter !== "all" && filter !== "interactive") throw new Error("Browser read_page filter is invalid");
    const page = await readBrowserPage(target.handle, {
      depth: optionalNumber(input, "depth"),
      filter,
      maxChars: optionalNumber(input, "max_chars"),
      refId: optionalString(input, "ref_id"),
    });
    this.assertTargetStable(binding, target, origin, "being read");
    return { ...page, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
  }

  private async find(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "find", "read", target);
    const result = await findInBrowserPage(target.handle, requiredString(input, "query", 4_096));
    this.assertTargetStable(binding, target, origin, "being searched");
    return { ...result, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
  }

  private async getPageText(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "get_page_text", "read", target);
    const result = await getBrowserPageText(target.handle, optionalNumber(input, "max_chars"));
    this.assertTargetStable(binding, target, origin, "being read");
    return { ...result, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
  }

  private async navigate(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const requestedUrl = requiredString(input, "url", 8_192);
    if (requestedUrl === "back" || requestedUrl === "forward") {
      const moved = requestedUrl === "back" ? target.handle.goBack?.() : target.handle.goForward?.();
      if (!moved) throw new Error(`Browser cannot navigate ${requestedUrl}`);
      return { direction: requestedUrl, tabId: target.id, tabContext: this.tabsContext(binding) };
    }
    const normalizedUrl = normalizeAgentNavigationUrl(requestedUrl, target.url);
    if (!normalizedUrl) throw new Error("Browser navigation URL must be public HTTPS or loopback HTTP(S)");
    const destinationOrigin = this.requireTargetOrigin(normalizedUrl);
    const destination = new URL(normalizedUrl);
    if (
      (destination.username || destination.password) &&
      !(await this.options.authorizeCredentialNavigation({ origin: destinationOrigin, sessionId }))
    ) {
      throw new Error(`User denied submitting URL credentials to ${destinationOrigin}`);
    }
    this.assertTargetStable(binding, target, browserOrigin(target.url), "being approved");
    await this.ensureOriginAccess(sessionId, binding, destinationOrigin, "navigate", "action", target);
    await this.panes.navigateAgentTab(target.contextId, target.id, normalizedUrl);
    const current = this.panes.resolveAgentTab(target.contextId, target.id);
    this.screenshots.delete(this.screenshotKey(target));
    return {
      origin: browserOrigin(current.url),
      tabId: current.id,
      url: browserSafeUrl(current.url),
      tabContext: this.tabsContext(binding),
    };
  }

  private async computer(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const action = requiredString(input, "action", 100);
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    const access = action === "screenshot" || action === "zoom" || action === "wait" ? "read" : "action";
    await this.ensureOriginAccess(sessionId, binding, origin, "computer", access, target);

    if (action === "screenshot" || action === "zoom") {
      const screenshot = await captureBrowserAgentScreenshot(target.handle);
      this.assertTargetStable(binding, target, origin, "being captured");
      this.screenshots.set(this.screenshotKey(target), { ...screenshot, navigationEpoch: target.navigationEpoch });
      return {
        image: { data: screenshot.data, mimetype: screenshot.mimeType },
        height: screenshot.height,
        origin,
        tabId: target.id,
        width: screenshot.width,
        tabContext: this.tabsContext(binding),
      };
    }
    if (action === "wait") {
      const duration = optionalNumber(input, "duration") ?? 1;
      if (duration < 0 || duration > 10) throw new Error("Browser wait duration must be between 0 and 10 seconds");
      await new Promise((resolve) => setTimeout(resolve, duration * 1_000));
      this.assertTargetStable(binding, target, origin, "waiting");
      return { duration, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
    }
    if (action === "scroll_to") {
      await scrollBrowserElementIntoView(target.handle, requiredString(input, "ref", 32));
      this.assertTargetStable(binding, target, origin, "scrolling");
      return { origin, tabId: target.id, tabContext: this.tabsContext(binding) };
    }

    if (action === "key") {
      const repeat = optionalNumber(input, "repeat") ?? 1;
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error("Browser key repeat is invalid");
      await dispatchBrowserKeys(target.handle, requiredString(input, "text", 4_096), repeat);
      this.assertTargetStable(binding, target, origin, "pressing keys");
      return { action, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
    }
    if (action === "type") {
      const ref = optionalString(input, "ref");
      if (ref) await focusBrowserElement(target.handle, ref);
      else if (input.coordinate !== undefined) {
        const point = this.translateScreenshotPoint(target, pointInput(input.coordinate, "action"));
        await dispatchBrowserClick(target.handle, point, { button: "left", clickCount: 1, modifiers: 0 });
      }
      await dispatchBrowserText(target.handle, requiredString(input, "text"));
      this.assertTargetStable(binding, target, origin, "typing");
      return { action, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
    }
    if (action === "left_click_drag") {
      const start = this.translateScreenshotPoint(target, pointInput(input.start_coordinate, "start"));
      const end = this.translateScreenshotPoint(target, pointInput(input.coordinate, "action"));
      await dispatchBrowserDrag(target.handle, start, end);
      this.assertTargetStable(binding, target, origin, "dragging");
      return { action, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
    }
    const point = await this.resolveActionPoint(target, input);
    this.assertTargetStable(binding, target, origin, "preparing input");
    switch (action) {
      case "left_click":
      case "right_click":
      case "double_click":
      case "triple_click":
        await dispatchBrowserClick(target.handle, point, {
          button: action === "right_click" ? "right" : "left",
          clickCount: action === "double_click" ? 2 : action === "triple_click" ? 3 : 1,
          modifiers: parseModifierBits(optionalString(input, "modifiers")),
        });
        break;
      case "hover":
        await dispatchBrowserHover(target.handle, point);
        break;
      case "scroll": {
        const direction = requiredString(input, "scroll_direction", 20);
        if (!["up", "down", "left", "right"].includes(direction)) throw new Error("Browser scroll direction is invalid");
        const amount = optionalNumber(input, "scroll_amount") ?? 3;
        if (!Number.isInteger(amount) || amount < 1 || amount > 10) throw new Error("Browser scroll amount must be between 1 and 10");
        await dispatchBrowserScroll(target.handle, point, direction as "down" | "left" | "right" | "up", amount);
        break;
      }
      default:
        throw new Error("Browser computer action is not supported");
    }
    return { action, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
  }

  private async formInput(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    const ref = requiredString(input, "ref", 32);
    if (!REF_PATTERN.test(ref)) throw new Error("Browser element ref is invalid; call read_page again");
    const value = input.value;
    if (!["boolean", "number", "string"].includes(typeof value)) throw new Error("Browser form_input value is invalid");
    await this.ensureOriginAccess(sessionId, binding, origin, "form_input", "action", target);
    await setBrowserFormInput(target.handle, ref, value as string | number | boolean);
    this.assertTargetStable(binding, target, origin, "editing a form");
    return { origin, ref, tabId: target.id, tabContext: this.tabsContext(binding) };
  }

  private async javascriptTool(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (input.action !== "javascript_exec") throw new Error("javascript_tool only supports javascript_exec");
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "javascript_tool", "action", target);
    const value = await evaluateInBrowserPage(target.handle, requiredString(input, "text"));
    this.assertTargetStable(binding, target, origin, "executing JavaScript");
    let result: unknown = value;
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > 50_000) result = `${serialized.slice(0, 50_000)}\n[result truncated]`;
    return { origin, result, tabId: target.id, tabContext: this.tabsContext(binding) };
  }

  private async readConsole(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "read_console_messages", "read", target);
    const diagnostics = target.handle.agentDiagnostics?.();
    if (!diagnostics) throw new Error("Browser console diagnostics are unavailable");
    const pattern = optionalString(input, "pattern")?.toLowerCase();
    const onlyErrors = input.onlyErrors === true;
    const limit = Math.min(200, Math.max(1, Math.floor(optionalNumber(input, "limit") ?? 50)));
    const messages = diagnostics.consoleMessages()
      .filter((entry) => entry.origin === null || entry.origin === origin)
      .filter((entry) => !onlyErrors || entry.level === "error")
      .filter((entry) => !pattern || entry.text.toLowerCase().includes(pattern))
      .slice(-limit);
    return { messages, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
  }

  private async readNetwork(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "read_network_requests", "read", target);
    const diagnostics = target.handle.agentDiagnostics?.();
    if (!diagnostics) throw new Error("Browser network diagnostics are unavailable");
    const requestId = optionalString(input, "requestId");
    if (requestId) {
      const body = await diagnostics.responseBody(requestId);
      this.assertTargetStable(binding, target, origin, "reading a network response");
      return { ...body, requestId, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
    }
    const pattern = optionalString(input, "urlPattern")?.toLowerCase();
    const limit = Math.min(200, Math.max(1, Math.floor(optionalNumber(input, "limit") ?? 50)));
    const requests = diagnostics.networkRequests()
      .filter((entry) => !pattern || entry.url.toLowerCase().includes(pattern))
      .slice(-limit);
    return { requests, origin, tabId: target.id, tabContext: this.tabsContext(binding) };
  }

  private async resizeWindow(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, optionalString(input, "tabId"));
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "resize_window", "action", target);
    const preset = optionalString(input, "preset");
    const presets: Record<string, BrowserPaneViewport> = {
      desktop: { height: 800, mobile: false, width: 1280 },
      mobile: { height: 812, mobile: true, width: 375 },
      tablet: { height: 1024, mobile: false, width: 768 },
    };
    const width = optionalNumber(input, "width");
    const height = optionalNumber(input, "height");
    const hasViewportInput = preset !== undefined || width !== undefined || height !== undefined;
    let viewport: BrowserPaneViewport | null | undefined;
    if (preset) {
      if (!(preset in presets)) throw new Error("Browser viewport preset is invalid");
      viewport = preset === "desktop" ? null : presets[preset];
    } else if (width !== undefined || height !== undefined) {
      const resolvedWidth = width ?? 1_280;
      const resolvedHeight = height ?? 800;
      if (resolvedWidth < 240 || resolvedWidth > 4_000 || resolvedHeight < 240 || resolvedHeight > 4_000) {
        throw new Error("Browser custom viewport must have width and height between 240 and 4000");
      }
      viewport = {
        height: Math.floor(resolvedHeight),
        mobile: resolvedWidth < 768,
        width: Math.floor(resolvedWidth),
      };
    }
    const colorScheme = optionalString(input, "colorScheme");
    if (!hasViewportInput && colorScheme === undefined) {
      throw new Error("Browser resize_window requires a preset, width, height, or colorScheme");
    }
    if (hasViewportInput) await this.panes.setViewport(target.contextId, target.id, viewport ?? null);
    if (colorScheme !== undefined) {
      if (colorScheme !== "light" && colorScheme !== "dark") throw new Error("Browser color scheme is invalid");
      await target.handle.setColorScheme?.(colorScheme);
    }
    this.screenshots.delete(this.screenshotKey(target));
    return {
      colorScheme: colorScheme ?? null,
      origin,
      tabId: target.id,
      viewport: viewport ?? null,
      tabContext: this.tabsContext(binding),
    };
  }

  private async resolveActionPoint(
    target: BoundBrowserAgentTarget,
    input: Record<string, unknown>,
  ): Promise<BrowserAgentPoint> {
    const ref = optionalString(input, "ref");
    if (ref) return resolveBrowserElementPoint(target.handle, ref);
    return this.translateScreenshotPoint(target, pointInput(input.coordinate, "action"));
  }

  private translateScreenshotPoint(target: BoundBrowserAgentTarget, point: BrowserAgentPoint): BrowserAgentPoint {
    const screenshot = this.screenshots.get(this.screenshotKey(target));
    if (!screenshot || screenshot.navigationEpoch !== target.navigationEpoch) {
      throw new Error("Coordinate actions require a current computer screenshot; take another screenshot first");
    }
    if (point.x < 0 || point.y < 0 || point.x > screenshot.width || point.y > screenshot.height) {
      throw new Error("Browser screenshot coordinate is outside the captured viewport");
    }
    return { x: point.x / screenshot.scale, y: point.y / screenshot.scale };
  }

  private resolveTarget(binding: BrowserAgentBinding, requestedTabId: unknown): BoundBrowserAgentTarget {
    if (requestedTabId !== undefined && requestedTabId !== null && typeof requestedTabId !== "string") {
      throw new Error("Browser tab id is invalid");
    }
    if (typeof requestedTabId === "string" && requestedTabId) {
      for (const contextId of binding.contextIds) {
        const snapshot = this.panes.getState(contextId);
        if (snapshot?.tabs.some((tab) => tab.id === requestedTabId)) {
          return { ...this.panes.resolveAgentTab(contextId, requestedTabId), contextId };
        }
      }
      throw new Error("Browser tab is not attached to this chat session");
    }
    return { ...this.panes.resolveAgentTab(binding.activeContextId), contextId: binding.activeContextId };
  }

  private requireTargetOrigin(url: string): string {
    const origin = browserOrigin(url);
    if (!origin) throw new Error("The selected Browser tab does not have a readable web origin");
    return origin;
  }

  private async ensureOriginAccess(
    sessionId: string,
    binding: BrowserAgentBinding,
    origin: string,
    tool: BrowserAgentToolName,
    access: "action" | "read",
    target: BoundBrowserAgentTarget,
  ): Promise<void> {
    if (isLoopbackOrigin(origin)) {
      binding.readOrigins.add(origin);
      if (access === "action") binding.actionOrigins.add(origin);
      return;
    }
    const grants = access === "action" ? binding.actionOrigins : binding.readOrigins;
    if (grants.has(origin)) return;
    const decision = await this.options.authorizeOrigin({ access, origin, sessionId, tool });
    if (decision === "deny") throw new Error(`User denied agent ${access} access to ${origin}`);
    this.assertTargetStable(binding, target, browserOrigin(target.url), "being approved");
    if (decision === "session") {
      grants.add(origin);
      binding.readOrigins.add(origin);
    }
  }

  private assertTargetStable(
    binding: BrowserAgentBinding,
    target: BoundBrowserAgentTarget,
    origin: string | null,
    action: string,
  ): void {
    const current = this.resolveTarget(binding, target.id);
    if (
      current.contextId !== target.contextId ||
      current.generation !== target.generation ||
      current.navigationEpoch !== target.navigationEpoch ||
      browserOrigin(current.url) !== origin
    ) {
      throw new Error(`The Browser page changed while it was ${action}; call read_page again`);
    }
  }

  private screenshotKey(target: Pick<BoundBrowserAgentTarget, "contextId" | "id">): string {
    return `${target.contextId}\0${target.id}`;
  }

  private assertId(value: string, label: string): void {
    if (!ID_PATTERN.test(value)) throw new Error(`Browser agent ${label} id is invalid`);
  }
}
