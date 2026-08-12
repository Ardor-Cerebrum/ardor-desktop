import { randomUUID } from "node:crypto";

import type {
  BrowserAutomationRequest,
  BrowserAutomationResult,
  BrowserBounds,
  BrowserControlAction,
  BrowserControlOptions,
  BrowserHost,
  BrowserTabHandle,
} from "./controller";
import { applyBrowserSurfacePresentation } from "./controller";
import type { BrowserPaneOpenLinkMode, BrowserSurfacePresentation } from "../bridge-contract";
import {
  DEFAULT_BROWSER_AUTOMATION_RESULT_BYTES,
  isAllowedBrowserOrigin,
  isBrowserNavigableUrl,
  isPublicBrowserUrl,
  normalizeBrowserAutomationResult,
  validateBrowserAutomationRequest,
} from "./security";
import type { BrowserPaneSessionStore } from "./pane-session-store";

export interface BrowserPaneTabSnapshot {
  id: string;
  generation: number;
  url: string;
  title: string;
  faviconUrl?: string;
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

export interface BrowserPaneMoveResult {
  source: BrowserPaneSnapshot | null;
  destination: BrowserPaneSnapshot;
}

export interface BrowserPaneTransferResult extends BrowserPaneMoveResult {
  transferId: string;
}

interface BrowserPaneTab {
  id: string;
  generation: number;
  handle: BrowserTabHandle;
  grantedOrigins: Set<string>;
  requestedUrl?: string;
  preferRequestedUrl?: boolean;
}

interface BrowserPaneContext {
  id: string;
  activeTabId: string;
  bounds: BrowserBounds;
  claimantId: string | null;
  presentation: BrowserSurfacePresentation;
  restoring: boolean;
  tabs: Map<string, BrowserPaneTab>;
  transferId: string | null;
}

interface BrowserPaneTabTransfer {
  id: string;
  destinationContextId: string;
  sourceActiveTabId: string;
  sourceContextId: string;
  sourceTabOrder: string[];
  tabId: string;
}

export interface BrowserPaneControllerOptions {
  partition?: string;
  maxResultBytes?: number;
  maxTabs?: number;
  onStateChanged?: (snapshot: BrowserPaneSnapshot) => void;
  restoreTabTimeoutMs?: number;
  sessionStore?: BrowserPaneSessionStore;
}

const DEFAULT_PARTITION = "persist:ardor-browser";
const DEFAULT_MAX_TABS = 9;
const DEFAULT_RESTORE_TAB_TIMEOUT_MS = 10_000;
const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9:_./-]{1,256}$/;
const CLAIMANT_ID_PATTERN = /^[a-zA-Z0-9:_./-]{1,256}$/;
const TRANSFER_ID_PATTERN =
  /^transfer:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function waitForLoadWithin(load: Promise<void>, timeoutMs?: number): Promise<void> {
  if (timeoutMs === undefined) {
    return load;
  }
  return new Promise((resolve, reject) => {
    // The bound releases context restoration without cancelling the WebContents
    // navigation. A late completion can still update the retained tab normally.
    const timeout = setTimeout(resolve, timeoutMs);
    load.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function hasBrowserOrigin(value: string): boolean {
  try {
    return new URL(value).origin !== "null";
  } catch {
    return false;
  }
}

function loadWithoutBlocking(handle: BrowserTabHandle, url: string): void {
  try {
    void handle.load(url).catch(() => undefined);
  } catch {
    // The requested tab and URL remain available when WebContents rejects a load synchronously.
  }
}

export class BrowserPaneController {
  private readonly contexts = new Map<string, BrowserPaneContext>();
  private readonly transfers = new Map<string, BrowserPaneTabTransfer>();
  private readonly partition: string;
  private readonly maxResultBytes: number;
  private readonly maxTabs: number;
  private readonly onStateChanged?: (snapshot: BrowserPaneSnapshot) => void;
  private readonly restoreTabTimeoutMs: number;
  private readonly sessionStore?: BrowserPaneSessionStore;
  private nextGeneration = 1;

  constructor(private readonly host: BrowserHost, options: BrowserPaneControllerOptions = {}) {
    this.partition = options.partition ?? DEFAULT_PARTITION;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_BROWSER_AUTOMATION_RESULT_BYTES;
    this.maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
    this.onStateChanged = options.onStateChanged;
    this.restoreTabTimeoutMs = options.restoreTabTimeoutMs ?? DEFAULT_RESTORE_TAB_TIMEOUT_MS;
    this.sessionStore = options.sessionStore;
    if (!Number.isSafeInteger(this.restoreTabTimeoutMs) || this.restoreTabTimeoutMs < 1) {
      throw new RangeError("restoreTabTimeoutMs must be a positive safe integer");
    }
  }

  async open(
    contextId: string,
    bounds: BrowserBounds,
    initialUrl?: string,
    presentation: BrowserSurfacePresentation = "visible",
  ): Promise<BrowserPaneSnapshot> {
    return this.openForClaimant(contextId, null, bounds, initialUrl, presentation);
  }

  async claim(
    contextId: string,
    claimantId: string,
    bounds: BrowserBounds,
    initialUrl?: string,
    presentation: BrowserSurfacePresentation = "visible",
  ): Promise<BrowserPaneSnapshot> {
    this.assertClaimantId(claimantId);
    return this.openForClaimant(contextId, claimantId, bounds, initialUrl, presentation);
  }

  private async openForClaimant(
    contextId: string,
    claimantId: string | null,
    bounds: BrowserBounds,
    initialUrl: string | undefined,
    presentation: BrowserSurfacePresentation,
  ): Promise<BrowserPaneSnapshot> {
    this.assertContextId(contextId);
    this.assertBounds(bounds, presentation === "visible");
    const existing = this.contexts.get(contextId);
    if (existing) {
      this.assertClaimAvailable(existing, claimantId);
      const shouldInvalidate =
        presentation === "visible" &&
        (existing.claimantId !== claimantId || existing.presentation !== "visible");
      existing.claimantId = claimantId;
      existing.bounds = bounds;
      existing.presentation = presentation;
      this.applyLayout(existing);
      if (shouldInvalidate) this.invalidateActiveTab(existing);
      return this.emit(existing);
    }

    const context: BrowserPaneContext = {
      id: contextId,
      activeTabId: "",
      bounds,
      claimantId,
      presentation,
      restoring: false,
      tabs: new Map(),
      transferId: null,
    };
    this.contexts.set(contextId, context);
    try {
      const saved = this.sessionStore?.get(contextId);
      if (saved) {
        context.restoring = true;
        await Promise.all(
          saved.tabs
            .slice(0, this.maxTabs)
            .map((tab) =>
              this.createTabInternal(context, tab.url || undefined, tab.id, true, this.restoreTabTimeoutMs),
            ),
        );
        context.restoring = false;
        context.activeTabId = context.tabs.has(saved.activeTabId) ? saved.activeTabId : [...context.tabs.keys()][0] ?? "";
        this.applyLayout(context);
        if (presentation === "visible") this.invalidateActiveTab(context);
        this.emit(context);
      } else {
        await this.createTabInternal(context, initialUrl);
      }
      return this.snapshot(context);
    } catch (error) {
      if (this.contexts.get(contextId) === context) {
        this.closeContext(contextId);
      }
      throw error;
    }
  }

  async createTab(contextId: string, url?: string): Promise<BrowserPaneSnapshot> {
    const context = this.requireContext(contextId);
    this.assertContextMutable(context);
    if (context.tabs.size >= this.maxTabs) {
      throw new Error("browser tab limit reached");
    }
    await this.createTabInternal(context, url);
    return this.snapshot(context);
  }

  openLink(contextId: string, url: string, mode: BrowserPaneOpenLinkMode): BrowserPaneSnapshot {
    const context = this.requireContext(contextId);
    this.assertContextMutable(context);
    this.assertOpenLinkMode(mode);
    const normalized = this.assertNavigableUrl(url);
    let tab = [...context.tabs.values()].find(({ handle }) => handle.url() === normalized);

    if (!tab) {
      const activeTab = context.tabs.get(context.activeTabId);
      const activeUrl = activeTab?.handle.url() ?? "";
      if (activeTab && !activeUrl.startsWith("file:") && !hasBrowserOrigin(activeUrl)) {
        tab = activeTab;
      } else {
        if (context.tabs.size >= this.maxTabs) {
          throw new Error("browser tab limit reached");
        }
        tab = this.createTabShell(context);
      }
    }

    const isExactMatch = tab.handle.url() === normalized;
    if (!isExactMatch || mode === "reload-existing") {
      tab.requestedUrl = normalized;
      tab.preferRequestedUrl = !hasBrowserOrigin(tab.handle.url());
      tab.grantedOrigins.add(new URL(normalized).origin);
      loadWithoutBlocking(tab.handle, normalized);
    }
    context.activeTabId = tab.id;
    this.applyLayout(context);
    if (context.presentation === "visible") {
      this.invalidateActiveTab(context);
    }
    return this.emit(context);
  }

  beginTabTransfer(
    sourceContextId: string,
    tabId: string,
    destinationContextId: string,
  ): BrowserPaneTransferResult {
    const source = this.requireContext(sourceContextId);
    this.assertContextMutable(source);
    this.assertContextId(destinationContextId);
    if (this.contexts.has(destinationContextId) || this.sessionStore?.get(destinationContextId)) {
      throw new Error("browser transfer destination is unavailable");
    }

    const tab = this.requireTab(source, tabId);
    const transferId = `transfer:${randomUUID()}`;
    const sourceTabOrder = [...source.tabs.keys()];
    const sourceActiveTabId = source.activeTabId;
    const sourceActiveTabChanged = source.activeTabId === tabId;
    this.persist(source, this.snapshot(source));
    this.sessionStore?.flush();

    const destination: BrowserPaneContext = {
      id: destinationContextId,
      activeTabId: tabId,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      claimantId: null,
      presentation: "hidden",
      restoring: false,
      tabs: new Map([[tabId, tab]]),
      transferId,
    };
    const transfer: BrowserPaneTabTransfer = {
      id: transferId,
      destinationContextId,
      sourceActiveTabId,
      sourceContextId,
      sourceTabOrder,
      tabId,
    };
    source.transferId = transferId;
    this.transfers.set(transferId, transfer);
    this.contexts.set(destinationContextId, destination);
    source.tabs.delete(tabId);
    this.applyLayout(destination);

    let sourceSnapshot: BrowserPaneSnapshot | null = null;
    if (source.tabs.size > 0) {
      if (sourceActiveTabChanged) {
        const movedIndex = sourceTabOrder.indexOf(tabId);
        source.activeTabId = sourceTabOrder[movedIndex + 1] ?? sourceTabOrder[movedIndex - 1] ?? "";
      }
      this.applyLayout(source);
      if (sourceActiveTabChanged && source.presentation === "visible") {
        this.invalidateActiveTab(source);
      }
      sourceSnapshot = this.emit(source);
    }

    return { transferId, source: sourceSnapshot, destination: this.emit(destination) };
  }

  commitTabTransfer(transferId: string): BrowserPaneMoveResult {
    const transfer = this.requireTransfer(transferId);
    const source = this.requireTransferContext(transfer.sourceContextId, transferId);
    const destination = this.requireTransferContext(transfer.destinationContextId, transferId);
    this.transfers.delete(transferId);
    source.transferId = null;
    destination.transferId = null;

    let sourceSnapshot: BrowserPaneSnapshot | null = null;
    if (source.tabs.size === 0) {
      this.contexts.delete(source.id);
      this.sessionStore?.delete(source.id);
    } else {
      sourceSnapshot = this.emit(source);
    }
    const destinationSnapshot = this.emit(destination);
    this.sessionStore?.flush();
    return { source: sourceSnapshot, destination: destinationSnapshot };
  }

  rollbackTabTransfer(transferId: string): BrowserPaneSnapshot {
    return this.rollbackTabTransferInternal(transferId, true);
  }

  private rollbackTabTransferInternal(transferId: string, notify: boolean): BrowserPaneSnapshot {
    const transfer = this.requireTransfer(transferId);
    const source = this.requireTransferContext(transfer.sourceContextId, transferId);
    const destination = this.requireTransferContext(transfer.destinationContextId, transferId);
    const tab = this.requireTab(destination, transfer.tabId);

    const restoredTabs = new Map<string, BrowserPaneTab>();
    for (const id of transfer.sourceTabOrder) {
      const restoredTab = id === transfer.tabId ? tab : source.tabs.get(id);
      if (!restoredTab) {
        throw new Error("browser tab transfer cannot be rolled back");
      }
      restoredTabs.set(id, restoredTab);
    }

    destination.tabs.delete(tab.id);
    this.contexts.delete(destination.id);
    this.transfers.delete(transferId);
    source.tabs = restoredTabs;
    source.activeTabId = transfer.sourceActiveTabId;
    source.transferId = null;
    destination.transferId = null;
    this.sessionStore?.delete(destination.id);
    this.applyLayout(source);
    if (source.presentation === "visible") {
      this.invalidateActiveTab(source);
    }
    const snapshot = this.snapshot(source);
    this.persist(source, snapshot);
    if (notify) {
      this.notify(snapshot);
    }
    this.sessionStore?.flush();
    return snapshot;
  }

  moveTab(sourceContextId: string, tabId: string, destinationContextId: string): BrowserPaneMoveResult {
    const transfer = this.beginTabTransfer(sourceContextId, tabId, destinationContextId);
    try {
      return this.commitTabTransfer(transfer.transferId);
    } catch (error) {
      if (this.transfers.has(transfer.transferId)) {
        this.rollbackTabTransfer(transfer.transferId);
      }
      throw error;
    }
  }

  selectTab(contextId: string, tabId: string): BrowserPaneSnapshot {
    const context = this.requireContext(contextId);
    this.assertContextMutable(context);
    this.requireTab(context, tabId);
    context.activeTabId = tabId;
    this.applyLayout(context);
    if (context.presentation === "visible") this.invalidateActiveTab(context);
    return this.emit(context);
  }

  async closeTab(contextId: string, tabId: string): Promise<BrowserPaneSnapshot> {
    const context = this.requireContext(contextId);
    this.assertContextMutable(context);
    const tab = this.requireTab(context, tabId);
    const ids = [...context.tabs.keys()];
    const closingIndex = ids.indexOf(tabId);
    applyBrowserSurfacePresentation(tab.handle, "hidden");
    tab.handle.close();
    context.tabs.delete(tabId);

    if (context.tabs.size === 0) {
      await this.createTabInternal(context);
      return this.snapshot(context);
    }
    const closedActiveTab = context.activeTabId === tabId;
    if (closedActiveTab) {
      context.activeTabId = ids[closingIndex + 1] ?? ids[closingIndex - 1] ?? [...context.tabs.keys()][0];
    }
    this.applyLayout(context);
    if (closedActiveTab && context.presentation === "visible") {
      this.invalidateActiveTab(context);
    }
    return this.emit(context);
  }

  async navigate(contextId: string, tabId: string, url: string, userInitiated: boolean): Promise<BrowserPaneSnapshot> {
    const context = this.requireContext(contextId);
    this.assertContextMutable(context);
    const tab = this.requireTab(context, tabId);
    const normalized = this.assertNavigableUrl(url);
    if (!userInitiated && !isAllowedBrowserOrigin(normalized, [...tab.grantedOrigins])) {
      throw new Error("browser origin is not granted");
    }
    if (userInitiated) {
      tab.grantedOrigins.add(new URL(normalized).origin);
    }
    tab.requestedUrl = normalized;
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
    this.assertContextMutable(context);
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

  layout(
    contextId: string,
    bounds: BrowserBounds,
    presentation: BrowserSurfacePresentation,
  ): BrowserPaneSnapshot {
    const context = this.requireContext(contextId);
    this.assertContextCanPresent(context);
    if (context.claimantId !== null) {
      throw new Error("browser pane is claimed by another surface");
    }
    this.assertBounds(bounds, presentation === "visible");
    context.bounds = bounds;
    context.presentation = presentation;
    this.applyLayout(context);
    return this.emit(context);
  }

  release(contextId: string, claimantId: string): boolean {
    this.assertContextId(contextId);
    this.assertClaimantId(claimantId);
    const context = this.contexts.get(contextId);
    if (!context || context.claimantId !== claimantId) {
      return false;
    }
    context.claimantId = null;
    context.presentation = "hidden";
    this.applyLayout(context);
    this.emit(context);
    return true;
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
    this.assertContextMutable(context);
    const tab = this.requireTab(context, tabId);
    const currentUrl = tab.handle.url();
    if (!isAllowedBrowserOrigin(currentUrl, [...tab.grantedOrigins])) {
      throw new Error("browser origin is not granted");
    }
    const params = validateBrowserAutomationRequest(request.method, request.params);
    const rawResult = await tab.handle.sendCommand(request.method, params);
    return normalizeBrowserAutomationResult(tab.generation, rawResult, this.maxResultBytes);
  }

  getState(contextId: string): BrowserPaneSnapshot | null {
    const context = this.contexts.get(contextId);
    return context ? this.snapshot(context) : null;
  }

  closeContext(contextId: string): boolean {
    this.assertContextId(contextId);
    let context = this.contexts.get(contextId);
    if (!context) {
      this.sessionStore?.delete(contextId);
      this.sessionStore?.flush();
      return false;
    }
    if (context.transferId) {
      const transfer = this.requireTransfer(context.transferId);
      const closesDestination = transfer.destinationContextId === contextId;
      this.rollbackTabTransferInternal(transfer.id, closesDestination);
      if (closesDestination) {
        return true;
      }
      context = this.contexts.get(contextId);
      if (!context) {
        return true;
      }
    }
    this.destroyContext(context);
    this.sessionStore?.delete(contextId);
    this.sessionStore?.flush();
    return true;
  }

  dispose(): void {
    for (const transferId of [...this.transfers.keys()]) {
      this.rollbackTabTransferInternal(transferId, false);
    }
    for (const context of [...this.contexts.values()]) {
      this.destroyContext(context);
    }
    this.transfers.clear();
    this.sessionStore?.flush();
  }

  private async createTabInternal(
    context: BrowserPaneContext,
    url?: string,
    preferredId?: string,
    retainOnLoadFailure = false,
    loadTimeoutMs?: number,
  ): Promise<BrowserPaneTab> {
    const tab = this.createTabShell(context, preferredId);
    const { handle, id } = tab;
    if (url) {
      const normalized = this.assertNavigableUrl(url);
      tab.requestedUrl = normalized;
      tab.grantedOrigins.add(new URL(normalized).origin);
      try {
        await waitForLoadWithin(handle.load(normalized), loadTimeoutMs);
      } catch (error) {
        if (!retainOnLoadFailure && this.contexts.get(context.id) === context && context.tabs.get(id) === tab) {
          context.tabs.delete(id);
          handle.close();
        }
        if (!retainOnLoadFailure) {
          throw error;
        }
      }
    }
    if (this.contexts.get(context.id) !== context || context.tabs.get(id) !== tab) {
      throw new Error("browser pane is unavailable");
    }
    this.emit(context);
    return tab;
  }

  private createTabShell(context: BrowserPaneContext, preferredId?: string): BrowserPaneTab {
    const generation = this.nextGeneration++;
    const id = preferredId && !this.hasTabId(preferredId) ? preferredId : `tab-${generation}`;
    const handle = this.host.create(
      id,
      this.partition,
      undefined,
      {
        onStateChanged: () => {
          const currentContext = this.findContextByTabId(id);
          if (currentContext) {
            const currentTab = currentContext.tabs.get(id);
            if (currentTab?.preferRequestedUrl && hasBrowserOrigin(currentTab.handle.url())) {
              currentTab.preferRequestedUrl = false;
            }
            this.emit(currentContext);
          }
        },
        onOpenRequested: (popupUrl) => {
          const currentContext = this.findContextByTabId(id);
          if (
            currentContext &&
            !currentContext.transferId &&
            isBrowserNavigableUrl(popupUrl) &&
            currentContext.tabs.size < this.maxTabs
          ) {
            void this.createTabInternal(currentContext, popupUrl).catch(() => undefined);
          }
        },
        onShortcutRequested: (shortcut) => {
          const currentContext = this.findContextByTabId(id);
          if (
            shortcut === "newTab" &&
            currentContext &&
            !currentContext.transferId &&
            currentContext.tabs.size < this.maxTabs
          ) {
            void this.createTabInternal(currentContext).catch(() => undefined);
          } else if (shortcut === "closeTab" && currentContext) {
            void this.closeTab(currentContext.id, id).catch(() => undefined);
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
    return tab;
  }

  private snapshot(context: BrowserPaneContext): BrowserPaneSnapshot {
    return {
      contextId: context.id,
      activeTabId: context.activeTabId,
      tabs: [...context.tabs.values()].map((tab) => {
        const liveUrl = tab.handle.url();
        const faviconUrl = tab.handle.faviconUrl?.();
        let url = tab.requestedUrl ?? "";
        if (!tab.preferRequestedUrl && liveUrl && liveUrl !== "about:blank") {
          url = liveUrl;
        }
        return {
          id: tab.id,
          generation: tab.generation,
          url,
          title: tab.handle.title?.() || "New tab",
          ...(faviconUrl ? { faviconUrl } : {}),
          loading: tab.handle.isLoading?.() ?? false,
          canGoBack: tab.handle.canGoBack?.() ?? false,
          canGoForward: tab.handle.canGoForward?.() ?? false,
          active: tab.id === context.activeTabId,
        };
      }),
    };
  }

  private emit(context: BrowserPaneContext): BrowserPaneSnapshot {
    const snapshot = this.snapshot(context);
    if (context.restoring || context.transferId) {
      return snapshot;
    }
    this.persist(context, snapshot);
    this.notify(snapshot);
    return snapshot;
  }

  private notify(snapshot: BrowserPaneSnapshot): void {
    try {
      this.onStateChanged?.(snapshot);
    } catch {
      // Renderer notification is best effort and must not change native transaction semantics.
    }
  }

  private persist(context: BrowserPaneContext, snapshot: BrowserPaneSnapshot): void {
    this.sessionStore?.set(context.id, {
      activeTabId: snapshot.activeTabId,
      tabs: snapshot.tabs.map(({ id, url }) => ({ id, url })),
      bounds: context.bounds,
      presentation: context.presentation,
    });
  }

  private hasTabId(tabId: string): boolean {
    return this.findContextByTabId(tabId) !== undefined;
  }

  private findContextByTabId(tabId: string): BrowserPaneContext | undefined {
    return [...this.contexts.values()].find((context) => context.tabs.has(tabId));
  }

  private destroyContext(context: BrowserPaneContext): void {
    this.contexts.delete(context.id);
    for (const tab of context.tabs.values()) {
      applyBrowserSurfacePresentation(tab.handle, "hidden");
      tab.handle.close();
    }
    context.tabs.clear();
  }

  private applyLayout(context: BrowserPaneContext): void {
    const activeTab = context.tabs.get(context.activeTabId);
    if (activeTab && context.presentation === "visible") activeTab.handle.raise?.();
    for (const tab of context.tabs.values()) {
      tab.handle.setBounds(context.bounds);
      if (tab.id !== context.activeTabId) {
        applyBrowserSurfacePresentation(tab.handle, "hidden");
      }
    }
    if (activeTab) {
      applyBrowserSurfacePresentation(activeTab.handle, context.presentation);
      if (context.presentation === "visible") activeTab.handle.raise?.();
    }
  }

  private invalidateActiveTab(context: BrowserPaneContext): void {
    context.tabs.get(context.activeTabId)?.handle.invalidate?.();
  }

  private assertClaimAvailable(context: BrowserPaneContext, claimantId: string | null): void {
    this.assertContextCanPresent(context);
    if (context.claimantId !== null && context.claimantId !== claimantId) {
      throw new Error("browser pane is claimed by another surface");
    }
  }

  private assertContextCanPresent(context: BrowserPaneContext): void {
    if (!context.transferId) {
      return;
    }
    const transfer = this.transfers.get(context.transferId);
    if (transfer?.destinationContextId === context.id) {
      throw new Error("browser transfer destination is not ready");
    }
  }

  private assertContextMutable(context: BrowserPaneContext): void {
    if (context.transferId) {
      throw new Error("browser pane has a pending tab transfer");
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

  private requireTransfer(transferId: string): BrowserPaneTabTransfer {
    this.assertTransferId(transferId);
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error("browser tab transfer is unavailable");
    }
    return transfer;
  }

  private requireTransferContext(contextId: string, transferId: string): BrowserPaneContext {
    const context = this.contexts.get(contextId);
    if (!context || context.transferId !== transferId) {
      throw new Error("browser tab transfer context is unavailable");
    }
    return context;
  }

  private assertContextId(contextId: string): void {
    if (!CONTEXT_ID_PATTERN.test(contextId)) {
      throw new Error("browser context id is invalid");
    }
  }

  private assertClaimantId(claimantId: string): void {
    if (!CLAIMANT_ID_PATTERN.test(claimantId)) {
      throw new Error("browser pane claimant is invalid");
    }
  }

  private assertTransferId(transferId: string): void {
    if (!TRANSFER_ID_PATTERN.test(transferId)) {
      throw new Error("browser tab transfer id is invalid");
    }
  }

  private assertNavigableUrl(value: string): string {
    if (!isBrowserNavigableUrl(value)) {
      throw new Error("browser URL must be public HTTPS or loopback HTTP(S)");
    }
    return new URL(value).toString();
  }

  private assertOpenLinkMode(value: string): asserts value is BrowserPaneOpenLinkMode {
    if (value !== "reload-existing" && value !== "focus-existing") {
      throw new Error("browser pane open-link mode is invalid");
    }
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
