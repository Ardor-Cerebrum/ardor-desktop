import type {
  BrowserAutomationRequest,
  BrowserAutomationResult,
  BrowserBounds,
  BrowserControlAction,
  BrowserControlOptions,
  BrowserHost,
  BrowserTabHandle,
} from "./controller";
import {
  isAllowedBrowserOrigin,
  isBrowserNavigableUrl,
  isPublicBrowserUrl,
  truncateBrowserPayload,
  validateBrowserAutomationRequest,
} from "./security";

export interface BrowserPaneTabSnapshot {
  id: string;
  generation: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
}

export interface BrowserPaneSnapshot {
  contextId: string;
  activeTabId: string;
  tabs: BrowserPaneTabSnapshot[];
}

interface BrowserPaneTab {
  id: string;
  generation: number;
  handle: BrowserTabHandle;
  grantedOrigins: Set<string>;
}

interface BrowserPaneContext {
  id: string;
  activeTabId: string;
  bounds: BrowserBounds;
  visible: boolean;
  tabs: Map<string, BrowserPaneTab>;
}

export interface BrowserPaneControllerOptions {
  partition?: string;
  maxResultBytes?: number;
  maxTabs?: number;
  onStateChanged?: (snapshot: BrowserPaneSnapshot) => void;
}

const DEFAULT_PARTITION = "persist:ardor-browser";
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_MAX_TABS = 9;
const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9:_./-]{1,256}$/;

export class BrowserPaneController {
  private readonly contexts = new Map<string, BrowserPaneContext>();
  private readonly partition: string;
  private readonly maxResultBytes: number;
  private readonly maxTabs: number;
  private readonly onStateChanged?: (snapshot: BrowserPaneSnapshot) => void;
  private nextGeneration = 1;

  constructor(private readonly host: BrowserHost, options: BrowserPaneControllerOptions = {}) {
    this.partition = options.partition ?? DEFAULT_PARTITION;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
    this.onStateChanged = options.onStateChanged;
  }

  async open(contextId: string, bounds: BrowserBounds, initialUrl?: string): Promise<BrowserPaneSnapshot> {
    this.assertContextId(contextId);
    this.assertBounds(bounds, true);
    const existing = this.contexts.get(contextId);
    if (existing) {
      existing.bounds = bounds;
      existing.visible = true;
      this.applyLayout(existing);
      return this.snapshot(existing);
    }

    const context: BrowserPaneContext = {
      id: contextId,
      activeTabId: "",
      bounds,
      visible: true,
      tabs: new Map(),
    };
    this.contexts.set(contextId, context);
    try {
      await this.createTabInternal(context, initialUrl);
      return this.snapshot(context);
    } catch (error) {
      this.closeContext(contextId);
      throw error;
    }
  }

  async createTab(contextId: string, url?: string): Promise<BrowserPaneSnapshot> {
    const context = this.requireContext(contextId);
    if (context.tabs.size >= this.maxTabs) {
      throw new Error("browser tab limit reached");
    }
    await this.createTabInternal(context, url);
    return this.snapshot(context);
  }

  selectTab(contextId: string, tabId: string): BrowserPaneSnapshot {
    const context = this.requireContext(contextId);
    this.requireTab(context, tabId);
    context.activeTabId = tabId;
    this.applyLayout(context);
    return this.emit(context);
  }

  async closeTab(contextId: string, tabId: string): Promise<BrowserPaneSnapshot> {
    const context = this.requireContext(contextId);
    const tab = this.requireTab(context, tabId);
    const ids = [...context.tabs.keys()];
    const closingIndex = ids.indexOf(tabId);
    tab.handle.setVisible(false);
    tab.handle.close();
    context.tabs.delete(tabId);

    if (context.tabs.size === 0) {
      await this.createTabInternal(context);
      return this.snapshot(context);
    }
    if (context.activeTabId === tabId) {
      context.activeTabId = ids[closingIndex + 1] ?? ids[closingIndex - 1] ?? [...context.tabs.keys()][0];
    }
    this.applyLayout(context);
    return this.emit(context);
  }

  async navigate(contextId: string, tabId: string, url: string, userInitiated: boolean): Promise<BrowserPaneSnapshot> {
    const context = this.requireContext(contextId);
    const tab = this.requireTab(context, tabId);
    const normalized = this.assertNavigableUrl(url);
    if (!userInitiated && !isAllowedBrowserOrigin(normalized, [...tab.grantedOrigins])) {
      throw new Error("browser origin is not granted");
    }
    if (userInitiated) {
      tab.grantedOrigins.add(new URL(normalized).origin);
    }
    await tab.handle.load(normalized);
    return this.emit(context);
  }

  async control(
    contextId: string,
    tabId: string,
    action: BrowserControlAction,
    options: BrowserControlOptions = {},
  ): Promise<boolean> {
    const context = this.requireContext(contextId);
    const handle = this.requireTab(context, tabId).handle;
    switch (action) {
      case "back":
        return handle.goBack?.() ?? false;
      case "forward":
        return handle.goForward?.() ?? false;
      case "reload":
        return handle.reload?.() ?? false;
      case "find":
        if (!options.query || new TextEncoder().encode(options.query).byteLength > 1024) {
          throw new Error("browser find query is invalid");
        }
        return handle.find?.(options.query, options.forward ?? true, options.findNext ?? false) ?? false;
      case "stopFind":
        return handle.stopFind?.() ?? false;
      case "setZoom":
        if (options.zoomFactor === undefined || !handle.setZoom) return false;
        if (!Number.isFinite(options.zoomFactor) || options.zoomFactor < 0.25 || options.zoomFactor > 5) {
          throw new Error("browser zoom factor is invalid");
        }
        handle.setZoom(options.zoomFactor);
        return true;
      case "openExternal": {
        const target = options.url ?? handle.url();
        if (!isPublicBrowserUrl(target)) {
          throw new Error("browser external URL must be public HTTPS");
        }
        return (await handle.openExternal?.(target)) ?? false;
      }
      case "openDevTools":
        return handle.openDevTools?.() ?? false;
      case "openDownloads":
        return (await handle.openDownloads?.()) ?? false;
      case "clearBrowsingData":
        return (await handle.clearBrowsingData?.()) ?? false;
      case "print":
        return (await handle.print?.()) ?? false;
      case "navigate":
        if (!options.url) return false;
        await this.navigate(contextId, tabId, options.url, options.userInitiated === true);
        return true;
      default:
        return false;
    }
  }

  layout(contextId: string, bounds: BrowserBounds, visible: boolean): BrowserPaneSnapshot {
    const context = this.requireContext(contextId);
    this.assertBounds(bounds, visible);
    context.bounds = bounds;
    context.visible = visible;
    this.applyLayout(context);
    return this.snapshot(context);
  }

  capture(contextId: string, tabId: string): Promise<string | null> {
    const context = this.requireContext(contextId);
    const handle = this.requireTab(context, tabId).handle;
    return handle.capturePage?.() ?? Promise.resolve(null);
  }

  async automate(
    contextId: string,
    tabId: string,
    request: BrowserAutomationRequest,
  ): Promise<BrowserAutomationResult> {
    const context = this.requireContext(contextId);
    const tab = this.requireTab(context, tabId);
    const currentUrl = tab.handle.url();
    if (!isAllowedBrowserOrigin(currentUrl, [...tab.grantedOrigins])) {
      throw new Error("browser origin is not granted");
    }
    const params = validateBrowserAutomationRequest(request.method, request.params);
    const rawResult = await tab.handle.sendCommand(request.method, params);
    const commandResult =
      rawResult && typeof rawResult === "object" && "result" in rawResult
        ? (rawResult as { result: unknown }).result
        : rawResult;
    const bounded = truncateBrowserPayload(commandResult, this.maxResultBytes);
    if (bounded.truncated) {
      return { generation: tab.generation, result: { truncated: true, value: bounded.value } };
    }
    const parsed = JSON.parse(bounded.value) as unknown;
    return {
      generation: tab.generation,
      result:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed },
    };
  }

  getState(contextId: string): BrowserPaneSnapshot | null {
    const context = this.contexts.get(contextId);
    return context ? this.snapshot(context) : null;
  }

  closeContext(contextId: string): boolean {
    const context = this.contexts.get(contextId);
    if (!context) return false;
    this.contexts.delete(contextId);
    for (const tab of context.tabs.values()) {
      tab.handle.setVisible(false);
      tab.handle.close();
    }
    context.tabs.clear();
    return true;
  }

  dispose(): void {
    for (const contextId of [...this.contexts.keys()]) {
      this.closeContext(contextId);
    }
  }

  private async createTabInternal(context: BrowserPaneContext, url?: string): Promise<BrowserPaneTab> {
    const generation = this.nextGeneration++;
    const id = `tab-${generation}`;
    const handle = this.host.create(
      id,
      this.partition,
      undefined,
      {
        onStateChanged: () => {
          if (context.tabs.has(id)) this.emit(context);
        },
        onOpenRequested: (popupUrl) => {
          if (isBrowserNavigableUrl(popupUrl) && context.tabs.size < this.maxTabs) {
            void this.createTabInternal(context, popupUrl).catch(() => undefined);
          }
        },
        onShortcutRequested: (shortcut) => {
          if (shortcut === "newTab" && context.tabs.size < this.maxTabs) {
            void this.createTabInternal(context).catch(() => undefined);
          } else if (shortcut === "closeTab" && context.tabs.has(id)) {
            void this.closeTab(context.id, id).catch(() => undefined);
          }
        },
      },
    );
    const tab: BrowserPaneTab = {
      id,
      generation,
      grantedOrigins: new Set(),
      handle,
    };
    context.tabs.set(id, tab);
    context.activeTabId = id;
    this.applyLayout(context);
    if (url) {
      const normalized = this.assertNavigableUrl(url);
      tab.grantedOrigins.add(new URL(normalized).origin);
      try {
        await handle.load(normalized);
      } catch (error) {
        context.tabs.delete(id);
        handle.close();
        throw error;
      }
    }
    this.emit(context);
    return tab;
  }

  private snapshot(context: BrowserPaneContext): BrowserPaneSnapshot {
    return {
      contextId: context.id,
      activeTabId: context.activeTabId,
      tabs: [...context.tabs.values()].map((tab) => ({
        id: tab.id,
        generation: tab.generation,
        url: tab.handle.url() === "about:blank" ? "" : tab.handle.url(),
        title: tab.handle.title?.() || "New tab",
        loading: tab.handle.isLoading?.() ?? false,
        canGoBack: tab.handle.canGoBack?.() ?? false,
        canGoForward: tab.handle.canGoForward?.() ?? false,
        active: tab.id === context.activeTabId,
      })),
    };
  }

  private emit(context: BrowserPaneContext): BrowserPaneSnapshot {
    const snapshot = this.snapshot(context);
    this.onStateChanged?.(snapshot);
    return snapshot;
  }

  private applyLayout(context: BrowserPaneContext): void {
    for (const tab of context.tabs.values()) {
      tab.handle.setBounds(context.bounds);
      tab.handle.setVisible(context.visible && tab.id === context.activeTabId);
    }
  }

  private requireContext(contextId: string): BrowserPaneContext {
    this.assertContextId(contextId);
    const context = this.contexts.get(contextId);
    if (!context) throw new Error("browser pane is unavailable");
    return context;
  }

  private requireTab(context: BrowserPaneContext, tabId: string): BrowserPaneTab {
    const tab = context.tabs.get(tabId);
    if (!tab) throw new Error("browser tab is unavailable");
    return tab;
  }

  private assertContextId(contextId: string): void {
    if (!CONTEXT_ID_PATTERN.test(contextId)) {
      throw new Error("browser context id is invalid");
    }
  }

  private assertNavigableUrl(value: string): string {
    if (!isBrowserNavigableUrl(value)) {
      throw new Error("browser URL must be public HTTPS or loopback HTTP(S)");
    }
    return new URL(value).toString();
  }

  private assertBounds(bounds: BrowserBounds, visible: boolean): void {
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.width < 0 ||
      bounds.height < 0 ||
      bounds.width > 16_384 ||
      bounds.height > 16_384 ||
      (visible && (bounds.width < 1 || bounds.height < 1))
    ) {
      throw new Error("browser bounds are invalid");
    }
  }
}
