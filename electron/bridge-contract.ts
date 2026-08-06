export const DESKTOP_BRIDGE_CHANNELS = [
  "desktop:runtime:get-info",
  "desktop:window:get-fullscreen",
  "desktop:window:fullscreen-changed",
  "desktop:auth:get-callback-status",
  "desktop:auth:get-pending-callback",
  "desktop:auth:complete-callback",
  "desktop:auth:open-url",
  "desktop:auth:logout",
  "desktop:auth:callback-ready",
  "desktop:update:check",
  "desktop:update:install",
  "desktop:update:relaunch",
  "desktop:update:event",
  "desktop:sidebar-browser:address-changed",
  "desktop:sidebar-browser:automate",
  "desktop:sidebar-browser:open",
  "desktop:sidebar-browser:get-active-tab",
  "desktop:sidebar-browser:layout",
  "desktop:sidebar-browser:control",
  "desktop:sidebar-browser:input",
  "desktop:sidebar-browser:close",
  "desktop:browser-pane:state-changed",
  "desktop:browser-pane:open",
  "desktop:browser-pane:get-state",
  "desktop:browser-pane:create-tab",
  "desktop:browser-pane:select-tab",
  "desktop:browser-pane:close-tab",
  "desktop:browser-pane:navigate",
  "desktop:browser-pane:control",
  "desktop:browser-pane:layout",
  "desktop:browser-pane:automate",
  "desktop:browser-pane:close",
  "desktop:browser-profile:get-settings",
  "desktop:browser-profile:update-preferences",
  "desktop:browser-profile:delete-credential",
  "desktop:browser-profile:fill-credential",
  "desktop:browser-profile:resolve-credential-prompt",
  "desktop:browser-profile:clear-download-history",
  "desktop:browser-profile:open-downloads",
  "desktop:browser-profile:list-site-data",
  "desktop:browser-profile:clear-site-data",
  "desktop:browser-profile:credential-options",
  "desktop:browser-profile:save-password-prompt",
  "desktop:browser-profile:downloads-changed",
] as const;

export type DesktopBridgeChannel = (typeof DESKTOP_BRIDGE_CHANNELS)[number];
export type DesktopUnlisten = () => void;

const desktopBridgeChannelSet = new Set<string>(DESKTOP_BRIDGE_CHANNELS);

export function isDesktopBridgeChannel(value: string): value is DesktopBridgeChannel {
  return desktopBridgeChannelSet.has(value);
}

export interface RuntimeInfo {
  readonly platform: NodeJS.Platform;
  readonly shellVersion: string;
  readonly desktopInstanceId: string;
}

export interface DesktopAuthCallbackStatus {
  callbackUrl: string;
  listening: boolean;
  error: string | null;
}

export interface PendingDesktopAuthCallback {
  callbackUrl: string;
  id: number;
}

export type DesktopUpdateNativeEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Verifying" }
  | { event: "Installing" };

export type SidebarBrowserSource = "artifact" | "solution";
export type SidebarBrowserAction =
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
export type SidebarBrowserAutomationMethod =
  | "Accessibility.getFullAXTree"
  | "CSS.getComputedStyleForNode"
  | "DOM.describeNode"
  | "DOM.disable"
  | "DOM.enable"
  | "DOM.focus"
  | "DOM.getAttributes"
  | "DOM.getBoxModel"
  | "DOM.getDocument"
  | "DOM.getOuterHTML"
  | "DOM.querySelector"
  | "DOM.querySelectorAll"
  | "DOMSnapshot.captureSnapshot"
  | "Input.dispatchKeyEvent"
  | "Input.dispatchMouseEvent"
  | "Input.insertText"
  | "Page.captureScreenshot"
  | "Page.getLayoutMetrics"
  | "Performance.getMetrics"
  | "Runtime.evaluate";
export type SidebarBrowserInputKind =
  | "focus"
  | "focusNext"
  | "focusPrevious"
  | "move"
  | "leave"
  | "leftDown"
  | "leftUp"
  | "leftDoubleClick"
  | "rightDown"
  | "rightUp"
  | "rightDoubleClick"
  | "middleDown"
  | "middleUp"
  | "middleDoubleClick"
  | "xDown"
  | "xUp"
  | "xDoubleClick"
  | "wheel"
  | "horizontalWheel";

export interface SidebarBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SidebarBrowserOverlay {
  bounds: SidebarBrowserBounds;
  cornerRadius: number;
}

export interface OpenSidebarBrowserRequest {
  url: string;
  source: SidebarBrowserSource;
  bounds: SidebarBrowserBounds;
  overlays: SidebarBrowserOverlay[];
}

export interface OpenSidebarBrowserResult {
  generation: number;
  devtoolsEnabled: boolean;
}

export interface SidebarBrowserInput {
  kind: SidebarBrowserInputKind;
  x: number;
  y: number;
  mouseData: number;
  buttons: number;
  control: boolean;
  shift: boolean;
}

export interface SidebarBrowserInputResult {
  accepted: boolean;
  cursor: string;
}

export interface SidebarBrowserAddressChangedEvent {
  generation: number;
  url: string;
}

export interface SidebarBrowserActiveTabSnapshot {
  generation: number;
  source: SidebarBrowserSource;
  url: string;
  title: string;
}

export interface SidebarBrowserControlOptions {
  url?: string;
  /** User-entered address-bar navigation may establish a new public origin. */
  userInitiated?: boolean;
  query?: string;
  forward?: boolean;
  findNext?: boolean;
  zoomFactor?: number;
}

export interface SidebarBrowserAutomationRequest {
  method: SidebarBrowserAutomationMethod;
  params?: Record<string, unknown>;
}

export interface SidebarBrowserAutomationResult {
  generation: number;
  result: Record<string, unknown>;
}

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

export type BrowserAutofillMode = "ask" | "automatic";
export type BrowserDownloadStatus = "inProgress" | "completed" | "failed";
export type BrowserCredentialPromptAction = "save" | "notNow";

export interface BrowserPreferences {
  autofillMode: BrowserAutofillMode;
  askToSavePasswords: boolean;
}

export interface BrowserCredentialMetadata {
  id: string;
  origin: string;
  username: string;
  createdAtUnixSeconds: number;
  updatedAtUnixSeconds: number;
}

export interface BrowserDownloadRecord {
  id: string;
  sourceOrigin: string;
  fileName: string;
  path: string;
  startedAtUnixSeconds: number;
  finishedAtUnixSeconds?: number;
  status: BrowserDownloadStatus;
}

export interface BrowserSettingsSnapshot {
  passwordStorageSupported: boolean;
  preferences: BrowserPreferences;
  credentials: BrowserCredentialMetadata[];
  downloads: BrowserDownloadRecord[];
}

export interface BrowserSiteData {
  domain: string;
  cookieCount: number;
}

export interface BrowserCredentialOptionsEvent {
  generation: number;
  origin: string;
  credentials: BrowserCredentialMetadata[];
}

export interface BrowserSavePasswordPromptEvent {
  promptId: string;
  generation: number;
  origin: string;
  username: string;
  isUpdate: boolean;
}

export interface ArdorDesktopBridge {
  readonly runtime: {
    getInfo(): Promise<RuntimeInfo>;
  };
  readonly windowChrome: {
    isFullscreen(): Promise<boolean>;
    onFullscreenChanged(handler: () => void): Promise<DesktopUnlisten>;
  };
  readonly auth: {
    getCallbackStatus(): Promise<DesktopAuthCallbackStatus>;
    getPendingCallback(): Promise<PendingDesktopAuthCallback | null>;
    completeCallback(callbackId: number): Promise<boolean>;
    openUrl(url: string): Promise<void>;
    /** Opens the validated Auth0 /v2/logout flow and returns to ardor://app. */
    logout(): Promise<void>;
    onCallbackReady(handler: () => void): Promise<DesktopUnlisten>;
  };
  readonly update: {
    check(): Promise<unknown>;
    install(onEvent: (event: DesktopUpdateNativeEvent) => void): Promise<unknown>;
    relaunch(): Promise<void>;
  };
  readonly sidebarBrowser: {
    onAddressChanged(handler: (payload: SidebarBrowserAddressChangedEvent) => void): Promise<DesktopUnlisten>;
    automate(generation: number, request: SidebarBrowserAutomationRequest): Promise<SidebarBrowserAutomationResult | null>;
    open(request: OpenSidebarBrowserRequest): Promise<OpenSidebarBrowserResult>;
    getActiveTab(): Promise<SidebarBrowserActiveTabSnapshot | null>;
    layout(
      generation: number,
      bounds: SidebarBrowserBounds,
      visible: boolean,
      overlays: SidebarBrowserOverlay[],
    ): Promise<boolean>;
    control(generation: number, action: SidebarBrowserAction, options: SidebarBrowserControlOptions): Promise<boolean>;
    input(generation: number, input: SidebarBrowserInput): Promise<SidebarBrowserInputResult>;
    close(generation: number): Promise<boolean>;
  };
  readonly browserPane: {
    onStateChanged(handler: (snapshot: BrowserPaneSnapshot) => void): Promise<DesktopUnlisten>;
    open(contextId: string, bounds: SidebarBrowserBounds, initialUrl?: string): Promise<BrowserPaneSnapshot>;
    getState(contextId: string): Promise<BrowserPaneSnapshot | null>;
    createTab(contextId: string, url?: string): Promise<BrowserPaneSnapshot>;
    selectTab(contextId: string, tabId: string): Promise<BrowserPaneSnapshot>;
    closeTab(contextId: string, tabId: string): Promise<BrowserPaneSnapshot>;
    navigate(contextId: string, tabId: string, url: string): Promise<BrowserPaneSnapshot>;
    control(
      contextId: string,
      tabId: string,
      action: SidebarBrowserAction,
      options: SidebarBrowserControlOptions,
    ): Promise<boolean>;
    layout(contextId: string, bounds: SidebarBrowserBounds, visible: boolean): Promise<BrowserPaneSnapshot>;
    automate(
      contextId: string,
      tabId: string,
      request: SidebarBrowserAutomationRequest,
    ): Promise<SidebarBrowserAutomationResult>;
    close(contextId: string): Promise<boolean>;
  };
  readonly browserProfile: {
    getSettings(): Promise<BrowserSettingsSnapshot>;
    updatePreferences(preferences: BrowserPreferences): Promise<BrowserSettingsSnapshot>;
    deleteCredential(credentialId: string): Promise<boolean>;
    fillCredential(generation: number, credentialId: string): Promise<boolean>;
    resolveCredentialPrompt(
      promptId: string,
      action: BrowserCredentialPromptAction,
    ): Promise<BrowserCredentialMetadata | null>;
    clearDownloadHistory(): Promise<BrowserSettingsSnapshot>;
    openDownloads(): Promise<void>;
    listSiteData(): Promise<BrowserSiteData[]>;
    clearSiteData(): Promise<boolean>;
    onCredentialOptions(handler: (payload: BrowserCredentialOptionsEvent) => void): Promise<DesktopUnlisten>;
    onSavePasswordPrompt(handler: (payload: BrowserSavePasswordPromptEvent) => void): Promise<DesktopUnlisten>;
    onDownloadsChanged(handler: (payload: BrowserDownloadRecord[]) => void): Promise<DesktopUnlisten>;
  };
}
