import {
  isAllowedBrowserOrigin,
  isPublicBrowserUrl,
  truncateBrowserPayload,
  validateBrowserAutomationRequest,
} from "./security";
import type { BrowserSiteData } from "../bridge-contract";

export type BrowserTabSource = "artifact" | "solution";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserOpenRequest {
  url: string;
  source: BrowserTabSource;
  bounds: BrowserBounds;
  overlays?: BrowserOverlay[];
}

export interface BrowserOverlay {
  bounds: BrowserBounds;
  cornerRadius: number;
}

export interface BrowserAutomationRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface BrowserAutomationResult {
  generation: number;
  result: Record<string, unknown>;
}

export interface BrowserTabHandle {
  load(url: string): Promise<void>;
  url(): string;
  setBounds(bounds: BrowserBounds): void;
  setVisible(visible: boolean): void;
  close(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  goBack?(): boolean;
  goForward?(): boolean;
  reload?(): boolean;
  stop?(): boolean;
  find?(query: string, forward: boolean, findNext: boolean): boolean;
  stopFind?(): boolean;
  setZoom?(zoomFactor: number): void;
  clearBrowsingData?(): Promise<boolean>;
  openDownloads?(): Promise<boolean>;
  openExternal?(url: string): Promise<boolean>;
  openDevTools?(): boolean;
  print?(): Promise<boolean>;
  input?(input: unknown): boolean;
  fillCredential?(username: string, password: string): Promise<boolean>;
  listSiteData?(): Promise<BrowserSiteData[]>;
  clearSiteData?(): Promise<boolean>;
}

export interface BrowserHost {
  create(tabId: string, partition: string, onUrlChanged?: (url: string) => void): BrowserTabHandle;
}

interface ActiveBrowserTab {
  generation: number;
  id: string;
  source: BrowserTabSource;
  handle: BrowserTabHandle;
  grantedOrigins: Set<string>;
}

export interface BrowserControllerOptions {
  partition?: string;
  maxResultBytes?: number;
  onAddressChanged?: (generation: number, url: string) => void;
}

export type BrowserControlAction =
  | "back"
  | "clearBrowsingData"
  | "find"
  | "forward"
  | "reload"
  | "navigate"
  | "openDownloads"
  | "openExternal"
  | "openDevTools"
  | "print"
  | "setZoom"
  | "stopFind";

export interface BrowserControlOptions {
  url?: string;
  query?: string;
  forward?: boolean;
  findNext?: boolean;
  zoomFactor?: number;
}

const DEFAULT_PARTITION = "persist:ardor-browser";
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;

export class BrowserController {
  private readonly partition: string;
  private readonly maxResultBytes: number;
  private nextGeneration = 1;
  private activeTab: ActiveBrowserTab | undefined;

  constructor(private readonly host: BrowserHost, options: BrowserControllerOptions = {}) {
    this.partition = options.partition ?? DEFAULT_PARTITION;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.onAddressChanged = options.onAddressChanged;
    if (!Number.isSafeInteger(this.maxResultBytes) || this.maxResultBytes < 1) {
      throw new RangeError("maxResultBytes must be a positive safe integer");
    }
  }

  private readonly onAddressChanged?: (generation: number, url: string) => void;

  async open(request: BrowserOpenRequest): Promise<{ generation: number }> {
    const url = this.assertNavigableUrl(request.url);
    if (request.source !== "artifact" && request.source !== "solution") {
      throw new Error("browser source is invalid");
    }
    this.assertBounds(request.bounds);
    this.assertOverlays(request.overlays ?? []);
    this.closeActiveTab();

    const generation = this.nextGeneration++;
    const id = `tab-${generation}`;
    const handle = this.host.create(id, this.partition, (changedUrl) => {
      if (this.activeTab?.generation === generation) {
        this.onAddressChanged?.(generation, changedUrl);
      }
    });
    const activeTab: ActiveBrowserTab = {
      generation,
      id,
      source: request.source,
      handle,
      grantedOrigins: new Set([new URL(url).origin]),
    };
    this.activeTab = activeTab;
    handle.setBounds(request.bounds);
    handle.setVisible(true);
    try {
      await handle.load(url);
    } catch (error) {
      if (this.activeTab === activeTab) {
        this.activeTab = undefined;
      }
      handle.close();
      throw error;
    }
    return { generation };
  }

  async navigate(generation: number, url: string): Promise<boolean> {
    const tab = this.requireTab(generation);
    const normalizedUrl = this.assertNavigableUrl(url);
    if (!isAllowedBrowserOrigin(normalizedUrl, [...tab.grantedOrigins])) {
      throw new Error("browser origin is not granted");
    }
    await tab.handle.load(normalizedUrl);
    return true;
  }

  control(generation: number, action: BrowserControlAction, options: BrowserControlOptions = {}): boolean {
    const handle = this.requireTab(generation).handle;
    switch (action) {
      case "back":
        return handle.goBack?.() ?? false;
      case "forward":
        return handle.goForward?.() ?? false;
      case "reload":
        return handle.reload?.() ?? false;
      case "stopFind":
        return handle.stopFind?.() ?? false;
      case "find":
        return handle.find?.(options.query ?? "", options.forward ?? true, options.findNext ?? false) ?? false;
      case "setZoom":
        if (options.zoomFactor === undefined || !handle.setZoom) return false;
        handle.setZoom(options.zoomFactor);
        return true;
      case "openDevTools":
        return handle.openDevTools?.() ?? false;
      case "openExternal":
        return false;
      case "clearBrowsingData":
      case "openDownloads":
      case "print":
        return false;
      default:
        return false;
    }
  }

  async controlAsync(generation: number, action: BrowserControlAction, options: BrowserControlOptions = {}): Promise<boolean> {
    if (action === "navigate") {
      if (!options.url) return false;
      return this.navigate(generation, options.url);
    }
    if (action === "openExternal") {
      const tab = this.requireTab(generation);
      const url = options.url ?? tab.handle.url();
      if (!isPublicBrowserUrl(url)) {
        throw new Error("browser external URL must be public HTTPS");
      }
      const handle = tab.handle;
      return (await handle.openExternal?.(url)) ?? false;
    }
    if (action === "clearBrowsingData") {
      return (await this.requireTab(generation).handle.clearBrowsingData?.()) ?? false;
    }
    if (action === "openDownloads") {
      return (await this.requireTab(generation).handle.openDownloads?.()) ?? false;
    }
    if (action === "print") {
      return (await this.requireTab(generation).handle.print?.()) ?? false;
    }
    return this.control(generation, action, options);
  }

  input(generation: number, input: unknown): boolean {
    return this.requireTab(generation).handle.input?.(input) ?? false;
  }

  async fillCredential(
    generation: number,
    credential: { origin: string; username: string; password: string },
  ): Promise<boolean> {
    const tab = this.requireTab(generation);
    if (!isAllowedBrowserOrigin(tab.handle.url(), [credential.origin])) {
      throw new Error("credential origin is not active");
    }
    return (await tab.handle.fillCredential?.(credential.username, credential.password)) ?? false;
  }

  async listSiteData(): Promise<BrowserSiteData[]> {
    return (await this.activeTab?.handle.listSiteData?.()) ?? [];
  }

  async clearSiteData(): Promise<boolean> {
    return (await this.activeTab?.handle.clearSiteData?.()) ?? false;
  }

  layout(generation: number, bounds: BrowserBounds, visible: boolean, overlays: BrowserOverlay[] = []): boolean {
    const tab = this.requireTab(generation);
    this.assertBounds(bounds);
    this.assertOverlays(overlays);
    tab.handle.setBounds(bounds);
    tab.handle.setVisible(visible);
    return true;
  }

  async automate(generation: number, request: BrowserAutomationRequest): Promise<BrowserAutomationResult> {
    const tab = this.requireTab(generation);
    if (tab.source !== "artifact") {
      throw new Error("browser automation is available only for artifact previews");
    }
    const params = validateBrowserAutomationRequest(request.method, request.params);
    const currentUrl = tab.handle.url();
    if (!isAllowedBrowserOrigin(currentUrl, [...tab.grantedOrigins])) {
      throw new Error("browser origin is not granted");
    }

    const rawResult = await tab.handle.sendCommand(request.method, params);
    const commandResult =
      rawResult && typeof rawResult === "object" && "result" in rawResult
        ? (rawResult as { result: unknown }).result
        : rawResult;
    const bounded = truncateBrowserPayload(commandResult, this.maxResultBytes);
    if (bounded.truncated) {
      return {
        generation,
        result: { truncated: true, value: bounded.value },
      };
    }

    const parsed = JSON.parse(bounded.value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { generation, result: { value: parsed } };
    }
    return { generation, result: parsed as Record<string, unknown> };
  }

  getUrl(generation: number): string {
    return this.requireTab(generation).handle.url();
  }

  close(generation: number): boolean {
    const tab = this.activeTab;
    if (!tab || tab.generation !== generation) {
      return false;
    }
    this.closeActiveTab();
    return true;
  }

  grantOrigin(generation: number, origin: string): boolean {
    const tab = this.requireTab(generation);
    const normalized = new URL(origin).origin;
    if (!isAllowedBrowserOrigin(normalized, [normalized])) {
      throw new Error("browser origin is invalid");
    }
    tab.grantedOrigins.add(normalized);
    return true;
  }

  private assertNavigableUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("browser URL is invalid");
    }
    if (!isPublicBrowserUrl(url.toString())) {
      throw new Error("browser URL must be a public HTTPS URL");
    }
    return url.toString();
  }

  private assertBounds(bounds: BrowserBounds): void {
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.width < 1 ||
      bounds.height < 1 ||
      bounds.width > 16_384 ||
      bounds.height > 16_384
    ) {
      throw new Error("browser bounds are invalid");
    }
  }

  private assertOverlays(overlays: BrowserOverlay[]): void {
    if (!Array.isArray(overlays) || overlays.length > 64) {
      throw new Error("browser overlays are invalid");
    }
    for (const overlay of overlays) {
      this.assertBounds(overlay.bounds);
      if (!Number.isFinite(overlay.cornerRadius) || overlay.cornerRadius < 0 || overlay.cornerRadius > 512) {
        throw new Error("browser overlay radius is invalid");
      }
    }
  }

  private requireTab(generation: number): ActiveBrowserTab {
    const tab = this.activeTab;
    if (!tab || tab.generation !== generation) {
      throw new Error("browser tab is unavailable");
    }
    return tab;
  }

  private closeActiveTab(): void {
    const tab = this.activeTab;
    if (!tab) {
      return;
    }
    this.activeTab = undefined;
    tab.handle.setVisible(false);
    tab.handle.close();
  }
}
