import type {
  BrowserElementSelection,
  BrowserMediaPermissionType,
  BrowserPaneColorScheme,
  BrowserPaneViewport,
  BrowserSiteData,
  BrowserSurfacePresentation,
} from "../bridge-contract";
import type { BrowserTabShortcut } from "./tab-shortcuts";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserAutomationRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface BrowserAutomationResult {
  generation: number;
  result: Record<string, unknown>;
}

export interface BrowserLoadError {
  code: number;
  description: string;
  url: string;
}

export interface BrowserTabHandle {
  load(url: string): Promise<void>;
  url(): string;
  title?(): string;
  faviconUrl?(): string | undefined;
  canGoBack?(): boolean;
  canGoForward?(): boolean;
  isLoading?(): boolean;
  loadError?(): BrowserLoadError | undefined;
  setBounds(bounds: BrowserBounds): void;
  setVisible(visible: boolean): void;
  /** Moves an already-mounted native view above sibling browser surfaces. */
  raise?(): void;
  /** Available on native WebContents-backed handles; non-native hosts may omit it. */
  setBackgroundThrottling?(enabled: boolean): void;
  invalidate?(): void;
  close(): void;
  capturePage?(): Promise<string | null>;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  setElementSelection?(enabled: boolean): Promise<boolean>;
  goBack?(): boolean;
  goForward?(): boolean;
  reload?(): boolean;
  stop?(): boolean;
  find?(query: string, forward: boolean, findNext: boolean): boolean;
  stopFind?(): boolean;
  setZoom?(zoomFactor: number): void;
  setColorScheme?(colorScheme: BrowserPaneColorScheme): Promise<boolean>;
  setViewport?(viewport: BrowserPaneViewport | null): Promise<boolean>;
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

export function applyBrowserSurfacePresentation(
  handle: BrowserTabHandle,
  presentation: BrowserSurfacePresentation,
): void {
  switch (presentation) {
    case "visible":
      handle.setBackgroundThrottling?.(true);
      handle.setVisible(true);
      return;
    case "occluded":
      handle.setBackgroundThrottling?.(false);
      handle.setVisible(false);
      return;
    case "hidden":
      handle.setBackgroundThrottling?.(true);
      handle.setVisible(false);
      return;
  }
}

export interface BrowserHostCallbacks {
  constrainVisualZoom?: boolean;
  disablePageDragRegions?: boolean;
  disableJavaScriptDialogs?: boolean;
  enablePageContextMenu?: boolean;
  enableWebAuthnAccountSelection?: boolean;
  keepChromeFocusOnNavigation?: boolean;
  ignoreBeforeUnload?: boolean;
  initialUserActivation?: boolean;
  isNavigationAllowed?: (url: string) => boolean;
  isPermissionAllowed?: (permission: string, requestingUrl: string | undefined) => boolean;
  onDestroyed?: () => void;
  onDownloadStarted?: () => void;
  onElementSelected?: (selection: BrowserElementSelection) => void;
  onMediaPermissionDenied?: (mediaTypes: BrowserMediaPermissionType[]) => void;
  onNavigationBlocked?: (hostname: string, reason: "credentials" | "policy") => void;
  onStateChanged?: () => void;
  onPopupRequested?: (request: BrowserPopupRequest) => BrowserPopupAdopter | null;
  onShortcutRequested?: (shortcut: BrowserTabShortcut) => void;
}

export interface BrowserPopupRequest {
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  features: string;
}

export type BrowserPopupTabFactory = (
  tabId: string,
  onUrlChanged?: (url: string) => void,
  callbacks?: BrowserHostCallbacks,
) => BrowserTabHandle;

export type BrowserPopupAdopter = (createTab: BrowserPopupTabFactory) => BrowserTabHandle | null;

export interface BrowserHost {
  create(
    tabId: string,
    partition: string,
    onUrlChanged?: (url: string) => void,
    callbacks?: BrowserHostCallbacks,
  ): BrowserTabHandle;
}

export interface BrowserPaneSurface {
  create(
    tabId: string,
    partition: string,
    onUrlChanged?: (url: string) => void,
    callbacks?: BrowserHostCallbacks,
  ): BrowserTabHandle;
  add(handle: BrowserTabHandle): void;
  remove(handle: BrowserTabHandle): void;
  setBounds(bounds: BrowserBounds): void;
  attach(): void;
  detach(): void;
  raise(handle: BrowserTabHandle): void;
  dispose(): void;
}

export interface BrowserPaneHost extends BrowserHost {
  createPaneSurface(contextId: string): BrowserPaneSurface;
}

export type BrowserControlAction =
  | "back"
  | "clearBrowsingData"
  | "find"
  | "forward"
  | "reload"
  | "stop"
  | "navigate"
  | "openDownloads"
  | "openExternal"
  | "openDevTools"
  | "print"
  | "setZoom"
  | "stopFind";

export interface BrowserControlOptions {
  url?: string;
  userInitiated?: boolean;
  query?: string;
  forward?: boolean;
  findNext?: boolean;
  zoomFactor?: number;
}
