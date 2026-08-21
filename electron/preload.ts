import { contextBridge, ipcRenderer } from "electron";

import type {
  ArdorDesktopBridge,
  ArtifactPaneSnapshot,
  BrowserAutomationRequest,
  BrowserAutomationResult,
  BrowserControlAction,
  BrowserControlOptions,
  BrowserCredentialOptionsEvent,
  BrowserDownloadRecord,
  BrowserSavePasswordPromptEvent,
  BrowserSettingsSnapshot,
  BrowserStorageMode,
  BrowserSiteData,
  BrowserCredentialMetadata,
  BrowserCredentialPromptAction,
  BrowserPreferences,
  BrowserProfileScope,
  BrowserPaneColorScheme,
  BrowserPaneOpenLinkMode,
  BrowserPaneElementSelectedEvent,
  BrowserPaneFocusExitEvent,
  BrowserPaneMediaPermissionDeniedEvent,
  BrowserPaneNavigationBlockedEvent,
  BrowserPaneSelectionShortcutEvent,
  BrowserPaneSnapshot,
  BrowserPaneViewport,
  BrowserPaneMoveResult,
  BrowserSurfacePresentation,
  BrowserSurfaceBounds,
  DesktopAuthCallbackStatus,
  DesktopBridgeChannel,
  DesktopUnlisten,
  DesktopUpdateNativeEvent,
  PendingDesktopAuthCallback,
  RuntimeInfo,
  TerminalEvent,
  TerminalOpenRequest,
  TerminalRestartRequest,
  TerminalResponse,
} from "./bridge-contract.js";

declare global {
  interface Window {
    ardorDesktop: ArdorDesktopBridge;
  }
}

function invoke<T>(channel: DesktopBridgeChannel, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function subscribe<T>(channel: DesktopBridgeChannel, handler: (payload: T) => void): Promise<DesktopUnlisten> {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return Promise.resolve(() => ipcRenderer.removeListener(channel, listener));
}

const bridge: ArdorDesktopBridge = Object.freeze({
  runtime: Object.freeze({
    getInfo: () => invoke<RuntimeInfo>("desktop:runtime:get-info"),
  }),
  windowChrome: Object.freeze({
    isFullscreen: () => invoke<boolean>("desktop:window:get-fullscreen"),
    onFullscreenChanged: (handler: () => void) =>
      subscribe<void>("desktop:window:fullscreen-changed", handler),
  }),
  auth: Object.freeze({
    getCallbackStatus: () => invoke<DesktopAuthCallbackStatus>("desktop:auth:get-callback-status"),
    getPendingCallback: () => invoke<PendingDesktopAuthCallback | null>("desktop:auth:get-pending-callback"),
    completeCallback: (callbackId: number) => invoke<boolean>("desktop:auth:complete-callback", callbackId),
    openUrl: (url: string) => invoke<void>("desktop:auth:open-url", url),
    logout: () => invoke<void>("desktop:auth:logout"),
    onCallbackReady: (handler: () => void) => subscribe<void>("desktop:auth:callback-ready", handler),
  }),
  external: Object.freeze({
    openUrl: (url: string) => invoke<void>("desktop:external:open-url", url),
  }),
  update: Object.freeze({
    check: () => invoke<unknown>("desktop:update:check"),
    install: (onEvent: (event: DesktopUpdateNativeEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: DesktopUpdateNativeEvent) => onEvent(payload);
      ipcRenderer.on("desktop:update:event", listener);
      return invoke<unknown>("desktop:update:install").finally(() => {
        ipcRenderer.removeListener("desktop:update:event", listener);
      });
    },
    relaunch: () => invoke<void>("desktop:update:relaunch"),
  }),
  browserPane: Object.freeze({
    onElementSelected: (handler: (event: BrowserPaneElementSelectedEvent) => void) =>
      subscribe<BrowserPaneElementSelectedEvent>("desktop:browser-pane:element-selected", handler),
    onFocusExit: (handler: (event: BrowserPaneFocusExitEvent) => void) =>
      subscribe<BrowserPaneFocusExitEvent>("desktop:browser-pane:focus-exit", handler),
    onSelectionShortcut: (handler: (event: BrowserPaneSelectionShortcutEvent) => void) =>
      subscribe<BrowserPaneSelectionShortcutEvent>("desktop:browser-pane:selection-shortcut", handler),
    onNavigationBlocked: (handler: (event: BrowserPaneNavigationBlockedEvent) => void) =>
      subscribe<BrowserPaneNavigationBlockedEvent>("desktop:browser-pane:navigation-blocked", handler),
    onMediaPermissionDenied: (handler: (event: BrowserPaneMediaPermissionDeniedEvent) => void) =>
      subscribe<BrowserPaneMediaPermissionDeniedEvent>(
        "desktop:browser-pane:media-permission-denied",
        handler,
      ),
    onStateChanged: (handler: (snapshot: BrowserPaneSnapshot) => void) =>
      subscribe<BrowserPaneSnapshot>("desktop:browser-pane:state-changed", handler),
    open: (
      contextId: string,
      bounds: BrowserSurfaceBounds,
      initialUrl?: string,
      presentation?: BrowserSurfacePresentation,
      profileScope?: BrowserProfileScope,
    ) => invoke<BrowserPaneSnapshot>("desktop:browser-pane:open", contextId, bounds, initialUrl, presentation, profileScope),
    claim: (
      contextId: string,
      claimantId: string,
      bounds: BrowserSurfaceBounds,
      initialUrl?: string,
      presentation?: BrowserSurfacePresentation,
      profileScope?: BrowserProfileScope,
    ) => invoke<BrowserPaneSnapshot>("desktop:browser-pane:claim", contextId, claimantId, bounds, initialUrl, presentation, profileScope),
    release: (contextId: string, claimantId: string) =>
      invoke<boolean>("desktop:browser-pane:release", contextId, claimantId),
    getState: (contextId: string) =>
      invoke<BrowserPaneSnapshot | null>("desktop:browser-pane:get-state", contextId),
    openLink: (contextId: string, url: string, mode: BrowserPaneOpenLinkMode) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:open-link", contextId, url, mode),
    createTab: (contextId: string, url?: string) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:create-tab", contextId, url),
    selectTab: (contextId: string, tabId: string) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:select-tab", contextId, tabId),
    closeTab: (contextId: string, tabId: string) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:close-tab", contextId, tabId),
    moveTab: (sourceContextId: string, tabId: string, destinationContextId: string) =>
      invoke<BrowserPaneMoveResult>("desktop:browser-pane:move-tab", sourceContextId, tabId, destinationContextId),
    navigate: (contextId: string, tabId: string, url: string) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:navigate", contextId, tabId, url),
    control: (
      contextId: string,
      tabId: string,
      action: BrowserControlAction,
      options: BrowserControlOptions,
    ) => invoke<boolean>("desktop:browser-pane:control", contextId, tabId, action, options),
    layout: (contextId: string, bounds: BrowserSurfaceBounds, presentation: BrowserSurfacePresentation) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:layout", contextId, bounds, presentation),
    capture: (contextId: string, tabId: string) =>
      invoke<string | null>("desktop:browser-pane:capture", contextId, tabId),
    automate: (contextId: string, tabId: string, request: BrowserAutomationRequest) =>
      invoke<BrowserAutomationResult>("desktop:browser-pane:automate", contextId, tabId, request),
    toggleElementSelection: (contextId: string, tabId: string, enabled: boolean) =>
      invoke<boolean>("desktop:browser-pane:toggle-element-selection", contextId, tabId, enabled),
    focus: (contextId: string) => invoke<boolean>("desktop:browser-pane:focus", contextId),
    setColorScheme: (contextId: string, colorScheme: BrowserPaneColorScheme) =>
      invoke<boolean>("desktop:browser-pane:set-color-scheme", contextId, colorScheme),
    setViewport: (contextId: string, tabId: string, viewport: BrowserPaneViewport | null) =>
      invoke<boolean>("desktop:browser-pane:set-viewport", contextId, tabId, viewport),
    close: (contextId: string) => invoke<boolean>("desktop:browser-pane:close", contextId),
  }),
  artifactPane: Object.freeze({
    open: (
      contextId: string,
      bounds: BrowserSurfaceBounds,
      url: string,
      presentation?: BrowserSurfacePresentation,
    ) => invoke<ArtifactPaneSnapshot>("desktop:artifact-pane:open", contextId, bounds, url, presentation),
    layout: (contextId: string, bounds: BrowserSurfaceBounds, presentation: BrowserSurfacePresentation) =>
      invoke<ArtifactPaneSnapshot>("desktop:artifact-pane:layout", contextId, bounds, presentation),
    reload: (contextId: string, url?: string) =>
      invoke<ArtifactPaneSnapshot>("desktop:artifact-pane:reload", contextId, url),
    capture: (contextId: string) => invoke<string | null>("desktop:artifact-pane:capture", contextId),
    automate: (contextId: string, request: BrowserAutomationRequest) =>
      invoke<BrowserAutomationResult>("desktop:artifact-pane:automate", contextId, request),
    close: (contextId: string) => invoke<boolean>("desktop:artifact-pane:close", contextId),
  }),
  terminal: Object.freeze({
    onEvent: (handler: (event: TerminalEvent) => void) =>
      subscribe<TerminalEvent>("desktop:terminal:event", handler),
    listProfiles: () => invoke<TerminalResponse>("desktop:terminal:list-profiles"),
    open: (terminalId: string, request: TerminalOpenRequest) =>
      invoke<TerminalResponse>("desktop:terminal:open", terminalId, request),
    detach: (terminalId: string, generation: number) =>
      invoke<TerminalResponse>("desktop:terminal:detach", terminalId, generation),
    restart: (terminalId: string, generation: number, request?: TerminalRestartRequest) =>
      invoke<TerminalResponse>("desktop:terminal:restart", terminalId, generation, request),
    write: (terminalId: string, generation: number, data: string) =>
      invoke<TerminalResponse>("desktop:terminal:write", terminalId, generation, data),
    resize: (terminalId: string, generation: number, cols: number, rows: number) =>
      invoke<TerminalResponse>("desktop:terminal:resize", terminalId, generation, cols, rows),
    ack: (terminalId: string, generation: number, sequence: number) =>
      invoke<TerminalResponse>("desktop:terminal:ack", terminalId, generation, sequence),
    clear: (terminalId: string, generation: number) =>
      invoke<TerminalResponse>("desktop:terminal:clear", terminalId, generation),
    close: (terminalId: string, generation: number) =>
      invoke<TerminalResponse>("desktop:terminal:close", terminalId, generation),
  }),
  browserProfile: Object.freeze({
    getSettings: () => invoke<BrowserSettingsSnapshot>("desktop:browser-profile:get-settings"),
    updateStorageMode: (storageMode: BrowserStorageMode) =>
      invoke<BrowserSettingsSnapshot>("desktop:browser-profile:update-storage-mode", storageMode),
    updatePreferences: (preferences: BrowserPreferences) =>
      invoke<BrowserSettingsSnapshot>("desktop:browser-profile:update-preferences", preferences),
    deleteCredential: (credentialId: string) => invoke<boolean>("desktop:browser-profile:delete-credential", credentialId),
    fillCredential: (generation: number, credentialId: string) =>
      invoke<boolean>("desktop:browser-profile:fill-credential", generation, credentialId),
    resolveCredentialPrompt: (promptId: string, action: BrowserCredentialPromptAction) =>
      invoke<BrowserCredentialMetadata | null>("desktop:browser-profile:resolve-credential-prompt", promptId, action),
    clearDownloadHistory: () => invoke<BrowserSettingsSnapshot>("desktop:browser-profile:clear-download-history"),
    openDownloads: () => invoke<void>("desktop:browser-profile:open-downloads"),
    listSiteData: () => invoke<BrowserSiteData[]>("desktop:browser-profile:list-site-data"),
    clearSiteData: () => invoke<boolean>("desktop:browser-profile:clear-site-data"),
    onCredentialOptions: (handler: (payload: BrowserCredentialOptionsEvent) => void) =>
      subscribe<BrowserCredentialOptionsEvent>("desktop:browser-profile:credential-options", handler),
    onSavePasswordPrompt: (handler: (payload: BrowserSavePasswordPromptEvent) => void) =>
      subscribe<BrowserSavePasswordPromptEvent>("desktop:browser-profile:save-password-prompt", handler),
    onDownloadsChanged: (handler: (payload: BrowserDownloadRecord[]) => void) =>
      subscribe<BrowserDownloadRecord[]>("desktop:browser-profile:downloads-changed", handler),
  }),
});

contextBridge.exposeInMainWorld("ardorDesktop", bridge);
