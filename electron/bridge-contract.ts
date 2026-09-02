import type {
  TerminalClientEvent,
  TerminalClientOpenRequest,
  TerminalClientResponse,
  TerminalClientRestartRequest,
  TerminalClientSnapshot,
} from "./terminal/client-contract.js";

export const DESKTOP_BRIDGE_CHANNELS = [
  "desktop:runtime:get-info",
  "desktop:window:get-fullscreen",
  "desktop:window:fullscreen-changed",
  "desktop:auth:get-status",
  "desktop:auth:start",
  "desktop:auth:get-token",
  "desktop:external:open-url",
  "desktop:auth:logout",
  "desktop:auth:logout-all",
  "desktop:auth:status-changed",
  "desktop:update:check",
  "desktop:update:install",
  "desktop:update:relaunch",
  "desktop:update:event",
  "desktop:browser-pane:state-changed",
  "desktop:browser-pane:navigation-blocked",
  "desktop:browser-pane:media-permission-denied",
  "desktop:browser-pane:element-selected",
  "desktop:browser-pane:selection-shortcut",
  "desktop:browser-pane:focus-exit",
  "desktop:browser-pane:open",
  "desktop:browser-pane:claim",
  "desktop:browser-pane:release",
  "desktop:browser-pane:get-state",
  "desktop:browser-pane:open-link",
  "desktop:browser-pane:create-tab",
  "desktop:browser-pane:select-tab",
  "desktop:browser-pane:close-tab",
  "desktop:browser-pane:move-tab",
  "desktop:browser-pane:navigate",
  "desktop:browser-pane:control",
  "desktop:browser-pane:layout",
  "desktop:browser-pane:capture",
  "desktop:browser-pane:automate",
  "desktop:browser-pane:toggle-element-selection",
  "desktop:browser-pane:focus",
  "desktop:browser-pane:set-color-scheme",
  "desktop:browser-pane:set-viewport",
  "desktop:browser-pane:close",
  "desktop:artifact-pane:open",
  "desktop:artifact-pane:layout",
  "desktop:artifact-pane:reload",
  "desktop:artifact-pane:capture",
  "desktop:artifact-pane:automate",
  "desktop:artifact-pane:close",
  "desktop:terminal:event",
  "desktop:terminal:list-profiles",
  "desktop:terminal:open",
  "desktop:terminal:detach",
  "desktop:terminal:restart",
  "desktop:terminal:write",
  "desktop:terminal:resize",
  "desktop:terminal:ack",
  "desktop:terminal:clear",
  "desktop:terminal:close",
  "desktop:browser-profile:get-settings",
  "desktop:browser-profile:update-storage-mode",
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

export const BROWSER_PANE_OPEN_LINK_MODES = ["reload-existing", "focus-existing"] as const;
export type BrowserPaneOpenLinkMode = (typeof BROWSER_PANE_OPEN_LINK_MODES)[number];

export function parseBrowserPaneOpenLinkMode(value: unknown): BrowserPaneOpenLinkMode {
  if (value === "reload-existing" || value === "focus-existing") {
    return value;
  }
  throw new Error("browser pane open-link mode is invalid");
}

export function parseBrowserPaneOpenLinkRequest(
  contextId: unknown,
  url: unknown,
  mode: unknown,
): [string, string, BrowserPaneOpenLinkMode] {
  if (typeof contextId !== "string" || typeof url !== "string") {
    throw new Error("browser pane open-link request is invalid");
  }
  return [contextId, url, parseBrowserPaneOpenLinkMode(mode)];
}

const desktopBridgeChannelSet = new Set<string>(DESKTOP_BRIDGE_CHANNELS);

export function isDesktopBridgeChannel(value: string): value is DesktopBridgeChannel {
  return desktopBridgeChannelSet.has(value);
}

export interface RuntimeInfo {
  readonly capabilities: {
    readonly authSessionV1: boolean;
    readonly localTerminalV1: boolean;
  };
  readonly platform: NodeJS.Platform;
  readonly shellVersion: string;
  readonly desktopInstanceId: string;
}

export interface DesktopAuthUser {
  readonly userId: string;
  readonly email: string;
  readonly role: "ADMIN" | "USER";
  readonly workspaceId: string;
  readonly isBetaUser: boolean;
  readonly isDeveloper: boolean;
}

export interface DesktopAuthStartState {
  readonly returnTo?: string;
  readonly userCopilotInput?: string;
}

export type DesktopAuthStatus =
  | {
      readonly state: "authenticated";
      readonly recoverable: boolean;
      readonly reason?: never;
      readonly appState?: DesktopAuthStartState;
    }
  | {
      readonly state: "signed-out" | "authorizing" | "error";
      readonly recoverable: boolean;
      readonly reason?: "authentication-required" | "configuration" | "encryption-unavailable" | "network";
      readonly appState?: never;
    };

const MAX_AUTH_RETURN_TO_LENGTH = 2_048;
const MAX_AUTH_COPILOT_INPUT_LENGTH = 255;
const AUTH_APP_ORIGIN = "https://ardor.desktop.invalid";

export function parseDesktopAuthStartState(value: unknown): DesktopAuthStartState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("desktop authentication request is invalid");
  }
  const state = value as Record<string, unknown>;
  if (Object.keys(state).some((key) => key !== "returnTo" && key !== "userCopilotInput")) {
    throw new Error("desktop authentication request is invalid");
  }

  const returnTo = parseDesktopAuthReturnTo(state.returnTo);
  const userCopilotInput = state.userCopilotInput;
  if (
    userCopilotInput !== undefined &&
    (typeof userCopilotInput !== "string" || userCopilotInput.length > MAX_AUTH_COPILOT_INPUT_LENGTH)
  ) {
    throw new Error("desktop authentication request is invalid");
  }
  return Object.freeze({
    ...(returnTo === undefined ? {} : { returnTo }),
    ...(userCopilotInput === undefined ? {} : { userCopilotInput }),
  });
}

function parseDesktopAuthReturnTo(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_AUTH_RETURN_TO_LENGTH ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("#") ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("desktop authentication request is invalid");
  }
  try {
    if (new URL(value, AUTH_APP_ORIGIN).origin !== AUTH_APP_ORIGIN) {
      throw new Error("desktop authentication request is invalid");
    }
  } catch {
    throw new Error("desktop authentication request is invalid");
  }
  return value;
}

export interface DesktopAuthToken {
  readonly internalToken: string;
  readonly expiresAt: number;
  readonly user: DesktopAuthUser;
}

export type DesktopUpdateNativeEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Verifying" }
  | { event: "Installing" };

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
export type BrowserAutomationMethod =
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
export interface BrowserSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserControlOptions {
  url?: string;
  /** User-entered address-bar navigation may establish a new public origin. */
  userInitiated?: boolean;
  query?: string;
  forward?: boolean;
  findNext?: boolean;
  zoomFactor?: number;
}

export interface BrowserAutomationRequest {
  method: BrowserAutomationMethod;
  params?: Record<string, unknown>;
}

export interface BrowserAutomationResult {
  generation: number;
  result: Record<string, unknown>;
}

export interface BrowserPaneTabSnapshot {
  id: string;
  generation: number;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  loadError?: {
    code: number;
    description: string;
    url: string;
  };
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
}

export interface BrowserPaneSnapshot {
  contextId: string;
  activeTabId: string;
  tabs: BrowserPaneTabSnapshot[];
}

export interface BrowserPaneNavigationBlockedEvent {
  contextId: string;
  tabId: string;
  hostname: string;
  reason: "credentials" | "policy";
}

export type BrowserMediaPermissionType = "camera" | "microphone";

export interface BrowserPaneMediaPermissionDeniedEvent {
  contextId: string;
  tabId: string;
  mediaTypes: BrowserMediaPermissionType[];
}

export interface BrowserElementBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserElementSelection {
  tagName: string;
  id?: string;
  classes: string[];
  attributes: Record<string, string>;
  computedStyles: Record<string, string>;
  boundingBox: BrowserElementBoundingBox;
  screenshot: string;
  innerText?: string;
  parentPath?: string;
  action?: string;
  reactComponent?: string;
  reactProps?: Record<string, unknown>;
  sourceFile?: string;
  outerHTML?: string;
  siblingHTML?: string;
}

export interface BrowserPaneElementSelectedEvent {
  contextId: string;
  tabId: string;
  selection: BrowserElementSelection;
}

export interface BrowserPaneSelectionShortcutEvent {
  contextId: string;
  tabId: string;
}

export interface BrowserPaneFocusExitEvent {
  contextId: string;
  tabId: string;
}

export interface BrowserPaneViewport {
  width: number;
  height: number;
  mobile: boolean;
}

export type BrowserPaneColorScheme = "light" | "dark";

export function parseBrowserPaneColorScheme(value: unknown): BrowserPaneColorScheme {
  if (value !== "light" && value !== "dark") {
    throw new Error("browser pane color scheme is invalid");
  }
  return value;
}

export function parseBrowserPaneViewport(value: unknown): BrowserPaneViewport | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("browser pane viewport is invalid");
  const { width, height, mobile } = value as Partial<BrowserPaneViewport>;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    (width ?? 0) < 1 ||
    (height ?? 0) < 1 ||
    (width ?? 0) > 8_192 ||
    (height ?? 0) > 8_192 ||
    typeof mobile !== "boolean"
  ) {
    throw new Error("browser pane viewport is invalid");
  }
  return { width: width as number, height: height as number, mobile };
}

export interface BrowserPaneMoveResult {
  source: BrowserPaneSnapshot | null;
  destination: BrowserPaneSnapshot;
}

/**
 * Presentation state for the native WebContentsView backing a pane surface.
 * Only the active browser tab may use `visible` or `occluded`.
 */
export type BrowserSurfacePresentation = "visible" | "occluded" | "hidden";

export interface ArtifactPaneSnapshot {
  contextId: string;
  generation: number;
  url: string;
  loading: boolean;
}

export type TerminalEvent = TerminalClientEvent;
export type TerminalOpenRequest = TerminalClientOpenRequest;
export type TerminalRestartRequest = TerminalClientRestartRequest;
export type TerminalResponse = TerminalClientResponse;
export type TerminalSnapshot = TerminalClientSnapshot;

export type BrowserAutofillMode = "ask" | "automatic";
export type BrowserStorageMode = "none" | "shared" | "session";
export type BrowserDownloadStatus = "inProgress" | "completed" | "failed";
export type BrowserCredentialPromptAction = "save" | "notNow";

export interface BrowserPreferences {
  autofillMode: BrowserAutofillMode;
  askToSavePasswords: boolean;
}

export interface BrowserProfileScope {
  workspaceId: string;
  sessionId: string;
}

export function parseBrowserProfileScope(value: unknown): BrowserProfileScope | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object") {
    throw new Error("browser profile scope is invalid");
  }
  const scope = value as Partial<BrowserProfileScope>;
  if (
    typeof scope.workspaceId !== "string" ||
    typeof scope.sessionId !== "string" ||
    !scope.workspaceId ||
    !scope.sessionId ||
    scope.workspaceId.length > 256 ||
    scope.sessionId.length > 256
  ) {
    throw new Error("browser profile scope is invalid");
  }
  return { workspaceId: scope.workspaceId, sessionId: scope.sessionId };
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
  storageMode: BrowserStorageMode;
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
  readonly authSessionV1: {
    getStatus(): Promise<DesktopAuthStatus>;
    start(state?: DesktopAuthStartState): Promise<DesktopAuthStatus>;
    getToken(): Promise<DesktopAuthToken>;
    logout(): Promise<DesktopAuthStatus>;
    logoutAll(): Promise<DesktopAuthStatus>;
    onStatusChanged(handler: (status: DesktopAuthStatus) => void): Promise<DesktopUnlisten>;
  };
  readonly external: {
    openUrl(url: string): Promise<void>;
  };
  readonly update: {
    check(): Promise<unknown>;
    install(onEvent: (event: DesktopUpdateNativeEvent) => void): Promise<unknown>;
    relaunch(): Promise<void>;
  };
  readonly browserPane: {
    onElementSelected(handler: (event: BrowserPaneElementSelectedEvent) => void): Promise<DesktopUnlisten>;
    onSelectionShortcut(handler: (event: BrowserPaneSelectionShortcutEvent) => void): Promise<DesktopUnlisten>;
    onFocusExit(handler: (event: BrowserPaneFocusExitEvent) => void): Promise<DesktopUnlisten>;
    onNavigationBlocked(handler: (event: BrowserPaneNavigationBlockedEvent) => void): Promise<DesktopUnlisten>;
    onMediaPermissionDenied(
      handler: (event: BrowserPaneMediaPermissionDeniedEvent) => void,
    ): Promise<DesktopUnlisten>;
    onStateChanged(handler: (snapshot: BrowserPaneSnapshot) => void): Promise<DesktopUnlisten>;
    open(
      contextId: string,
      bounds: BrowserSurfaceBounds,
      initialUrl?: string,
      presentation?: BrowserSurfacePresentation,
      profileScope?: BrowserProfileScope,
    ): Promise<BrowserPaneSnapshot>;
    claim(
      contextId: string,
      claimantId: string,
      bounds: BrowserSurfaceBounds,
      initialUrl?: string,
      presentation?: BrowserSurfacePresentation,
      profileScope?: BrowserProfileScope,
    ): Promise<BrowserPaneSnapshot>;
    release(contextId: string, claimantId: string): Promise<boolean>;
    getState(contextId: string): Promise<BrowserPaneSnapshot | null>;
    openLink(contextId: string, url: string, mode: BrowserPaneOpenLinkMode): Promise<BrowserPaneSnapshot>;
    createTab(contextId: string, url?: string): Promise<BrowserPaneSnapshot>;
    selectTab(contextId: string, tabId: string): Promise<BrowserPaneSnapshot>;
    closeTab(contextId: string, tabId: string): Promise<BrowserPaneSnapshot>;
    moveTab(sourceContextId: string, tabId: string, destinationContextId: string): Promise<BrowserPaneMoveResult>;
    navigate(contextId: string, tabId: string, url: string): Promise<BrowserPaneSnapshot>;
    control(
      contextId: string,
      tabId: string,
      action: BrowserControlAction,
      options: BrowserControlOptions,
    ): Promise<boolean>;
    layout(
      contextId: string,
      bounds: BrowserSurfaceBounds,
      presentation: BrowserSurfacePresentation,
    ): Promise<BrowserPaneSnapshot>;
    capture(contextId: string, tabId: string): Promise<string | null>;
    automate(
      contextId: string,
      tabId: string,
      request: BrowserAutomationRequest,
    ): Promise<BrowserAutomationResult>;
    toggleElementSelection(contextId: string, tabId: string, enabled: boolean): Promise<boolean>;
    focus(contextId: string): Promise<boolean>;
    setColorScheme(contextId: string, colorScheme: BrowserPaneColorScheme): Promise<boolean>;
    setViewport(contextId: string, tabId: string, viewport: BrowserPaneViewport | null): Promise<boolean>;
    close(contextId: string): Promise<boolean>;
  };
  readonly artifactPane: {
    open(
      contextId: string,
      bounds: BrowserSurfaceBounds,
      url: string,
      presentation?: BrowserSurfacePresentation,
    ): Promise<ArtifactPaneSnapshot>;
    layout(
      contextId: string,
      bounds: BrowserSurfaceBounds,
      presentation: BrowserSurfacePresentation,
    ): Promise<ArtifactPaneSnapshot>;
    reload(contextId: string, url?: string): Promise<ArtifactPaneSnapshot>;
    capture(contextId: string): Promise<string | null>;
    automate(contextId: string, request: BrowserAutomationRequest): Promise<BrowserAutomationResult>;
    close(contextId: string): Promise<boolean>;
  };
  readonly terminal: {
    onEvent(handler: (event: TerminalEvent) => void): Promise<DesktopUnlisten>;
    listProfiles(): Promise<TerminalResponse>;
    open(terminalId: string, request: TerminalOpenRequest): Promise<TerminalResponse>;
    detach(terminalId: string, generation: number): Promise<TerminalResponse>;
    restart(terminalId: string, generation: number, request?: TerminalRestartRequest): Promise<TerminalResponse>;
    write(terminalId: string, generation: number, data: string): Promise<TerminalResponse>;
    resize(terminalId: string, generation: number, cols: number, rows: number): Promise<TerminalResponse>;
    ack(terminalId: string, generation: number, sequence: number): Promise<TerminalResponse>;
    clear(terminalId: string, generation: number): Promise<TerminalResponse>;
    close(terminalId: string, generation: number): Promise<TerminalResponse>;
  };
  readonly browserProfile: {
    getSettings(): Promise<BrowserSettingsSnapshot>;
    updateStorageMode(storageMode: BrowserStorageMode): Promise<BrowserSettingsSnapshot>;
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
