import { contextBridge, ipcRenderer } from "electron";

import type {
  ArdorDesktopBridge,
  ArtifactPaneSnapshot,
  BrowserCredentialOptionsEvent,
  BrowserDownloadRecord,
  BrowserSavePasswordPromptEvent,
  BrowserSettingsSnapshot,
  BrowserSiteData,
  BrowserCredentialMetadata,
  BrowserCredentialPromptAction,
  BrowserPreferences,
  BrowserPaneSnapshot,
  BrowserSurfacePresentation,
  DesktopAuthCallbackStatus,
  DesktopBridgeChannel,
  DesktopUnlisten,
  DesktopUpdateNativeEvent,
  OpenSidebarBrowserRequest,
  OpenSidebarBrowserResult,
  PendingDesktopAuthCallback,
  RuntimeInfo,
  SidebarBrowserAction,
  SidebarBrowserAddressChangedEvent,
  SidebarBrowserActiveTabSnapshot,
  SidebarBrowserAutomationRequest,
  SidebarBrowserAutomationResult,
  SidebarBrowserBounds,
  SidebarBrowserControlOptions,
  SidebarBrowserInput,
  SidebarBrowserInputResult,
  SidebarBrowserOverlay,
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
  sidebarBrowser: Object.freeze({
    onAddressChanged: (handler: (payload: SidebarBrowserAddressChangedEvent) => void) =>
      subscribe<SidebarBrowserAddressChangedEvent>("desktop:sidebar-browser:address-changed", handler),
    automate: (generation: number, request: SidebarBrowserAutomationRequest) =>
      invoke<SidebarBrowserAutomationResult | null>("desktop:sidebar-browser:automate", generation, request),
    open: (request: OpenSidebarBrowserRequest) =>
      invoke<OpenSidebarBrowserResult>("desktop:sidebar-browser:open", request),
    getActiveTab: () => invoke<SidebarBrowserActiveTabSnapshot | null>("desktop:sidebar-browser:get-active-tab"),
    layout: (
      generation: number,
      bounds: SidebarBrowserBounds,
      visible: boolean,
      overlays: SidebarBrowserOverlay[],
    ) => invoke<boolean>("desktop:sidebar-browser:layout", generation, bounds, visible, overlays),
    control: (generation: number, action: SidebarBrowserAction, options: SidebarBrowserControlOptions) =>
      invoke<boolean>("desktop:sidebar-browser:control", generation, action, options),
    input: (generation: number, input: SidebarBrowserInput) =>
      invoke<SidebarBrowserInputResult>("desktop:sidebar-browser:input", generation, input),
    close: (generation: number) => invoke<boolean>("desktop:sidebar-browser:close", generation),
  }),
  browserPane: Object.freeze({
    onStateChanged: (handler: (snapshot: BrowserPaneSnapshot) => void) =>
      subscribe<BrowserPaneSnapshot>("desktop:browser-pane:state-changed", handler),
    open: (
      contextId: string,
      bounds: SidebarBrowserBounds,
      initialUrl?: string,
      presentation?: BrowserSurfacePresentation,
    ) => invoke<BrowserPaneSnapshot>("desktop:browser-pane:open", contextId, bounds, initialUrl, presentation),
    getState: (contextId: string) =>
      invoke<BrowserPaneSnapshot | null>("desktop:browser-pane:get-state", contextId),
    createTab: (contextId: string, url?: string) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:create-tab", contextId, url),
    selectTab: (contextId: string, tabId: string) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:select-tab", contextId, tabId),
    closeTab: (contextId: string, tabId: string) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:close-tab", contextId, tabId),
    navigate: (contextId: string, tabId: string, url: string) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:navigate", contextId, tabId, url),
    control: (
      contextId: string,
      tabId: string,
      action: SidebarBrowserAction,
      options: SidebarBrowserControlOptions,
    ) => invoke<boolean>("desktop:browser-pane:control", contextId, tabId, action, options),
    layout: (contextId: string, bounds: SidebarBrowserBounds, presentation: BrowserSurfacePresentation) =>
      invoke<BrowserPaneSnapshot>("desktop:browser-pane:layout", contextId, bounds, presentation),
    capture: (contextId: string, tabId: string) =>
      invoke<string | null>("desktop:browser-pane:capture", contextId, tabId),
    automate: (contextId: string, tabId: string, request: SidebarBrowserAutomationRequest) =>
      invoke<SidebarBrowserAutomationResult>("desktop:browser-pane:automate", contextId, tabId, request),
    close: (contextId: string) => invoke<boolean>("desktop:browser-pane:close", contextId),
  }),
  artifactPane: Object.freeze({
    open: (
      contextId: string,
      bounds: SidebarBrowserBounds,
      url: string,
      presentation?: BrowserSurfacePresentation,
    ) => invoke<ArtifactPaneSnapshot>("desktop:artifact-pane:open", contextId, bounds, url, presentation),
    layout: (contextId: string, bounds: SidebarBrowserBounds, presentation: BrowserSurfacePresentation) =>
      invoke<ArtifactPaneSnapshot>("desktop:artifact-pane:layout", contextId, bounds, presentation),
    reload: (contextId: string, url?: string) =>
      invoke<ArtifactPaneSnapshot>("desktop:artifact-pane:reload", contextId, url),
    capture: (contextId: string) => invoke<string | null>("desktop:artifact-pane:capture", contextId),
    automate: (contextId: string, request: SidebarBrowserAutomationRequest) =>
      invoke<SidebarBrowserAutomationResult>("desktop:artifact-pane:automate", contextId, request),
    close: (contextId: string) => invoke<boolean>("desktop:artifact-pane:close", contextId),
  }),
  browserProfile: Object.freeze({
    getSettings: () => invoke<BrowserSettingsSnapshot>("desktop:browser-profile:get-settings"),
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
