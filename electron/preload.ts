import { contextBridge, ipcRenderer } from "electron";

import type {
  ArdorDesktopBridge,
  BrowserCredentialOptionsEvent,
  BrowserDownloadRecord,
  BrowserSavePasswordPromptEvent,
  BrowserSettingsSnapshot,
  BrowserSiteData,
  BrowserCredentialMetadata,
  BrowserCredentialPromptAction,
  BrowserPreferences,
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
  auth: Object.freeze({
    getCallbackStatus: () => invoke<DesktopAuthCallbackStatus>("desktop:auth:get-callback-status"),
    getPendingCallback: () => invoke<PendingDesktopAuthCallback | null>("desktop:auth:get-pending-callback"),
    completeCallback: (callbackId: number) => invoke<boolean>("desktop:auth:complete-callback", callbackId),
    openUrl: (url: string) => invoke<void>("desktop:auth:open-url", url),
    logout: () => invoke<void>("desktop:auth:logout"),
    onCallbackReady: (handler: () => void) => subscribe<void>("desktop:auth:callback-ready", handler),
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
