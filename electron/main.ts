import {
  app,
  autoUpdater,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from "electron";
import "electron-squirrel-startup";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isDesktopBridgeChannel,
  parseBrowserPaneColorScheme,
  parseBrowserProfileScope,
  parseBrowserPaneViewport,
  parseBrowserPaneOpenLinkRequest,
  type BrowserAutomationRequest,
  type BrowserControlAction,
  type BrowserControlOptions,
  type BrowserPaneElementSelectedEvent,
  type BrowserPaneFocusExitEvent,
  type BrowserPaneMediaPermissionDeniedEvent,
  type BrowserPaneNavigationBlockedEvent,
  type BrowserPaneSelectionShortcutEvent,
  type DesktopBridgeChannel,
  type BrowserPaneSnapshot,
  type BrowserSurfacePresentation,
  type BrowserSettingsSnapshot,
  type BrowserSiteData,
  type BrowserStorageMode,
  type BrowserSurfaceBounds,
  type DesktopAuthCallbackStatus,
  type DesktopUpdateNativeEvent,
} from "./bridge-contract.js";
import { ArtifactPaneController } from "./browser/artifact-pane-controller.js";
import { BrowserPaneController } from "./browser/pane-controller.js";
import { createWebContentsBrowserHost } from "./browser/webcontents-host.js";
import { handOffBrowserFocusToChrome } from "./browser/focus-handoff.js";
import { resolveAppAssetPath } from "./app-assets.js";
import {
  resolveDesktopApplicationIdentity,
  resolveDesktopUserDataPath,
} from "./application-identity.js";
import { DesktopAuthCallbackServer } from "./auth/callback-server.js";
import { isAuth0AuthorizeUrlAllowed } from "./auth/authorize.js";
import { rewriteAuth0TokenCorsHeaders } from "./auth/cors.js";
import { buildAuth0LogoutUrl } from "./auth/logout.js";
import { getShellProtocolRegistration } from "./auth/protocol.js";
import { parseDesktopRuntimeConfig, resolveDesktopRuntimeConfig, type DesktopRuntimeConfig } from "./auth/runtime-config.js";
import { BrowserProfileStore, type BrowserProfileStorage, type CredentialProtector } from "./browser/profile-store.js";
import { BrowserProfileSessionService } from "./browser/profile-session-service.js";
import { createFileBrowserPaneSessionStorage } from "./browser/pane-session-storage.js";
import { BrowserPaneSessionStore } from "./browser/pane-session-store.js";
import { configureBrowserWebAuthn } from "./browser/webauthn-account-selection.js";
import { openExternalUrl } from "./external-url.js";
import { focusMainWindow as focusDesktopMainWindow } from "./focus-main-window.js";
import { MAIN_WINDOW_STARTUP_VISIBILITY, stageMainWindowReveal } from "./main-window-startup.js";
import { configureMacOSAutofillPolicy } from "./macos-autofill-policy.js";
import { DesktopUpdater } from "./updater.js";
import { resolveMainWindowChrome } from "./window-chrome.js";
import { resolveWindowsAppUserModelId } from "./windows-app-id.js";

const SHELL_SCHEME = "ardor";
const SHELL_ORIGIN = `${SHELL_SCHEME}://app`;
const { applicationName, channel: desktopChannel } = resolveDesktopApplicationIdentity({
  channel: process.env.ARDOR_ELECTRON_CHANNEL,
  executablePath: process.execPath,
  isPackaged: app.isPackaged,
});
app.setName(applicationName);
app.setPath("userData", resolveDesktopUserDataPath(app.getPath("appData"), applicationName));
configureMacOSAutofillPolicy(systemPreferences);
if (process.platform === "win32") {
  app.setAppUserModelId(resolveWindowsAppUserModelId(desktopChannel));
}
const DESKTOP_AUTH_STATUS_UNAVAILABLE: DesktopAuthCallbackStatus = Object.freeze({
  callbackUrl: "http://127.0.0.1:17631/auth/callback",
  listening: false,
  error: "auth callback server is unavailable",
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: SHELL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow: BrowserWindow | undefined;
let browserPaneController: BrowserPaneController | undefined;
let artifactPaneController: ArtifactPaneController | undefined;
let callbackServer: DesktopAuthCallbackServer | undefined;
let desktopUpdater: DesktopUpdater | undefined;
let browserProfileStore: BrowserProfileStore | undefined;
let browserProfileSessionService: BrowserProfileSessionService | undefined;
let browserPaneSessionStore: BrowserPaneSessionStore | undefined;
let desktopRuntimeConfig: DesktopRuntimeConfig | null | undefined;
let quitPersistenceComplete = false;
let quitPersistencePromise: Promise<void> | undefined;
let quitForUpdate = false;
const desktopInstanceId = randomUUID();

async function flushBrowserPersistentData(): Promise<void> {
  try {
    await browserProfileSessionService?.flushPersistentData();
  } catch {
    console.warn("Browser session data could not be fully persisted before shutdown");
  }
}

function isTrustedShellUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${SHELL_SCHEME}:` && url.host === "app";
  } catch {
    return false;
  }
}

function assertTrustedShellSender(event: IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!isTrustedShellUrl(frameUrl)) {
    throw new Error("Desktop bridge request rejected for an untrusted sender");
  }
}

function loadDesktopRuntimeConfig(): DesktopRuntimeConfig | null {
  if (desktopRuntimeConfig !== undefined) {
    return desktopRuntimeConfig;
  }

  const configPaths = [
    resolve(app.getAppPath(), "dist", "electron", "runtime-config.json"),
    resolve(process.resourcesPath, "runtime-config.json"),
    resolve(process.resourcesPath, "ardor-runtime-config.json"),
  ];
  for (const configPath of configPaths) {
    try {
      desktopRuntimeConfig = parseDesktopRuntimeConfig(JSON.parse(readFileSync(configPath, "utf8")));
      return desktopRuntimeConfig;
    } catch {
      // Try the next packaged location or the development environment below.
    }
  }

  try {
    desktopRuntimeConfig = resolveDesktopRuntimeConfig(process.env);
  } catch {
    desktopRuntimeConfig = null;
  }
  return desktopRuntimeConfig;
}

function requireDesktopRuntimeConfig(): DesktopRuntimeConfig {
  const config = loadDesktopRuntimeConfig();
  if (!config) {
    throw new Error("desktop Auth0 runtime config is unavailable");
  }
  return config;
}

function authUrlIsAllowed(value: unknown): value is string {
  const config = loadDesktopRuntimeConfig();
  return config
    ? isAuth0AuthorizeUrlAllowed(value, { domain: config.auth0Domain, clientId: config.auth0ClientId })
    : false;
}

function configureAuth0TokenCors(): void {
  const config = loadDesktopRuntimeConfig();
  if (!config) {
    return;
  }

  session.defaultSession.webRequest.onHeadersReceived(
    { urls: [`https://${config.auth0Domain}/oauth/token`] },
    (details, callback) => {
      callback({
        responseHeaders: rewriteAuth0TokenCorsHeaders(details.responseHeaders, SHELL_ORIGIN),
      });
    },
  );
}

function registerBridgeHandler<T extends DesktopBridgeChannel>(
  channel: T,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown,
): void {
  if (!isDesktopBridgeChannel(channel)) {
    throw new Error(`Attempted to register an unsupported desktop bridge channel: ${channel}`);
  }

  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedShellSender(event);
    return handler(event, ...args);
  });
}

function resolveUiDirectory(): string {
  const configured = process.env.ARDOR_UI_DIST_DIR;
  if (configured) {
    return resolve(configured);
  }
  if (app.isPackaged) {
    return resolve(process.resourcesPath, "dist");
  }
  return resolve(app.getAppPath(), "..", "solutions-ui", "dist");
}

function resolveAppAsset(uiDirectory: string, requestUrl: string): string | null {
  const request = new URL(requestUrl);
  if (request.protocol !== `${SHELL_SCHEME}:` || request.host !== "app") {
    return null;
  }

  const pathname = decodeURIComponent(request.pathname || "/");
  if (pathname.includes("\0")) {
    return null;
  }

  return resolveAppAssetPath(realpathSync(uiDirectory), pathname);
}

async function serveAppAsset(requestUrl: string): Promise<Response> {
  const uiDirectory = resolveUiDirectory();
  if (!existsSync(uiDirectory)) {
    return new Response("Ardor UI bundle is unavailable", { status: 503 });
  }

  const asset = resolveAppAsset(uiDirectory, requestUrl);
  if (!asset) {
    return new Response("Not found", { status: 404 });
  }

  return net.fetch(pathToFileURL(asset).toString());
}

function focusMainWindow(): boolean {
  return focusDesktopMainWindow(app, mainWindow, process.platform);
}

function configureApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.getName(),
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
}

function configureDevelopmentDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged || !app.dock) {
    return;
  }
  app.dock.setIcon(resolve(app.getAppPath(), "assets", "icons", desktopChannel, "dock-icon.png"));
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    ...MAIN_WINDOW_STARTUP_VISIBILITY,
    ...resolveMainWindowChrome(process.platform),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      preload: resolve(app.getAppPath(), "dist", "electron", "preload.cjs"),
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedShellUrl(url)) {
      event.preventDefault();
    }
  });
  const notifyFullscreenChanged = () => {
    window.webContents.send("desktop:window:fullscreen-changed");
  };
  window.on("enter-full-screen", notifyFullscreenChanged);
  window.on("leave-full-screen", notifyFullscreenChanged);
  stageMainWindowReveal(window);
  let closePersistencePromise: Promise<void> | undefined;
  const disposeNativePanes = () => {
    if (mainWindow !== window) return;
    browserPaneController?.dispose();
    browserPaneController = undefined;
    artifactPaneController?.dispose();
    artifactPaneController = undefined;
  };
  window.on("close", (event) => {
    if (mainWindow !== window) return;
    if (quitPersistenceComplete || quitForUpdate) {
      disposeNativePanes();
      return;
    }

    event.preventDefault();
    if (closePersistencePromise) return;
    closePersistencePromise = flushBrowserPersistentData();
    void closePersistencePromise.then(() => {
      disposeNativePanes();
      if (!window.isDestroyed()) window.destroy();
    });
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  void window.loadURL(`${SHELL_ORIGIN}/index.html`);
  return window;
}

function registerShellProtocolClient(): void {
  try {
    const registration = getShellProtocolRegistration(
      SHELL_SCHEME,
      process.defaultApp,
      process.execPath,
      process.argv[1] ? resolve(process.argv[1]) : undefined,
    );
    if (registration.executablePath && registration.args) {
      app.setAsDefaultProtocolClient(registration.protocol, registration.executablePath, registration.args);
    } else {
      app.setAsDefaultProtocolClient(registration.protocol);
    }
  } catch {
    // Protocol registration is best effort in development and restricted CI sandboxes.
  }
}

function attachBrowserPaneController(window: BrowserWindow): BrowserPaneController {
  const controller = new BrowserPaneController(createWebContentsBrowserHost(window), {
    resolvePartition: (profileScope) =>
      profileScope && browserProfileSessionService
        ? browserProfileSessionService.partitionFor(profileScope)
        : "persist:ardor-browser",
    sessionStore: browserPaneSessionStore,
    onNavigationBlocked: (event: BrowserPaneNavigationBlockedEvent) => {
      if (!window.isDestroyed()) {
        window.webContents.send("desktop:browser-pane:navigation-blocked", event);
      }
    },
    onMediaPermissionDenied: (event: BrowserPaneMediaPermissionDeniedEvent) => {
      if (!window.isDestroyed()) {
        window.webContents.send("desktop:browser-pane:media-permission-denied", event);
      }
    },
    onElementSelected: (event: BrowserPaneElementSelectedEvent) => {
      if (!window.isDestroyed()) {
        window.webContents.send("desktop:browser-pane:element-selected", event);
      }
    },
    onFocusExit: (event: BrowserPaneFocusExitEvent) => {
      handOffBrowserFocusToChrome(window, event);
    },
    onSelectionShortcut: (event: BrowserPaneSelectionShortcutEvent) => {
      if (!window.isDestroyed()) {
        window.webContents.send("desktop:browser-pane:selection-shortcut", event);
      }
    },
    onStateChanged: (snapshot: BrowserPaneSnapshot) => {
      if (!window.isDestroyed()) {
        window.webContents.send("desktop:browser-pane:state-changed", snapshot);
      }
    },
  });
  browserPaneController?.dispose();
  browserPaneController = controller;
  return controller;
}

function attachArtifactPaneController(window: BrowserWindow): ArtifactPaneController {
  const controller = new ArtifactPaneController(createWebContentsBrowserHost(window));
  artifactPaneController?.dispose();
  artifactPaneController = controller;
  return controller;
}

function initializeBrowserProfileStore(): void {
  const profilePath = resolve(app.getPath("userData"), "browser-profile.json");
  const storage: BrowserProfileStorage = {
    load: () => {
      try {
        return readFileSync(profilePath, "utf8");
      } catch {
        return undefined;
      }
    },
    save: (value) => {
      mkdirSync(resolve(profilePath, ".."), { recursive: true });
      writeFileSync(profilePath, value, { encoding: "utf8", mode: 0o600 });
      chmodSync(profilePath, 0o600);
    },
  };
  const protector: CredentialProtector = {
    supported: safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  };
  browserProfileStore = new BrowserProfileStore(storage, protector);
  browserProfileSessionService = new BrowserProfileSessionService(
    (partition) => session.fromPartition(partition),
    browserProfileStore,
  );
}

function initializeBrowserPaneSessionStore(): void {
  const sessionPath = resolve(app.getPath("userData"), "browser-pane-session.bin");
  browserPaneSessionStore = new BrowserPaneSessionStore({
    storage: createFileBrowserPaneSessionStorage(sessionPath),
    protector: {
      supported: safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
  });
}

function browserSettingsSnapshot(): BrowserSettingsSnapshot {
  return browserProfileStore?.snapshot() ?? {
    passwordStorageSupported: false,
    storageMode: "shared",
    preferences: { autofillMode: "ask", askToSavePasswords: false },
    credentials: [],
    downloads: [],
  };
}

function requireBrowserPaneController(): BrowserPaneController {
  if (!browserPaneController) {
    throw new Error("browser pane controller is unavailable");
  }
  return browserPaneController;
}

function requireArtifactPaneController(): ArtifactPaneController {
  if (!artifactPaneController) {
    throw new Error("artifact pane controller is unavailable");
  }
  return artifactPaneController;
}

function parseBrowserSurfacePresentation(value: unknown): BrowserSurfacePresentation {
  if (value === "visible" || value === "occluded" || value === "hidden") {
    return value;
  }
  throw new Error("browser surface presentation is invalid");
}

function registerBridgeHandlers(): void {
  registerBridgeHandler("desktop:runtime:get-info", () => ({
    platform: process.platform,
    shellVersion: app.getVersion(),
    desktopInstanceId,
  }));

  registerBridgeHandler("desktop:window:get-fullscreen", () => mainWindow?.isFullScreen() ?? false);
  registerBridgeHandler("desktop:auth:get-callback-status", () => callbackServer?.getStatus() ?? DESKTOP_AUTH_STATUS_UNAVAILABLE);
  registerBridgeHandler("desktop:auth:get-pending-callback", () => callbackServer?.getPending() ?? null);
  registerBridgeHandler("desktop:auth:complete-callback", (_event, callbackId) => {
    if (typeof callbackId !== "number" || !Number.isSafeInteger(callbackId)) {
      throw new Error("auth callback id is invalid");
    }
    return callbackServer?.complete(callbackId) ?? false;
  });
  registerBridgeHandler("desktop:auth:open-url", async (_event, value) => {
    if (!authUrlIsAllowed(value)) {
      throw new Error("Auth0 authorization URL is not allowed");
    }
    if (!callbackServer) {
      throw new Error("auth callback server is unavailable");
    }
    callbackServer.beginAuthorization(value);
    await shell.openExternal(value);
  });
  registerBridgeHandler("desktop:external:open-url", (_event, value) =>
    openExternalUrl(value, (url) => shell.openExternal(url)),
  );
  registerBridgeHandler("desktop:auth:logout", async () => {
    const config = requireDesktopRuntimeConfig();
    const logoutUrl = buildAuth0LogoutUrl({
      domain: config.auth0Domain,
      allowedDomain: config.auth0Domain,
      clientId: config.auth0ClientId,
      returnTo: SHELL_ORIGIN,
    });
    await shell.openExternal(logoutUrl);
  });

  registerBridgeHandler("desktop:update:check", () => desktopUpdater?.check() ?? { status: "up-to-date" });
  registerBridgeHandler("desktop:update:install", () => desktopUpdater?.install() ?? "up-to-date");
  registerBridgeHandler("desktop:update:relaunch", () => desktopUpdater?.relaunch());

  registerBridgeHandler("desktop:browser-pane:open", (_event, contextId, bounds, initialUrl, presentation, profileScope) =>
    requireBrowserPaneController().open(
      String(contextId),
      bounds as BrowserSurfaceBounds,
      typeof initialUrl === "string" && initialUrl ? initialUrl : undefined,
      presentation === undefined ? "visible" : parseBrowserSurfacePresentation(presentation),
      parseBrowserProfileScope(profileScope),
    ),
  );
  registerBridgeHandler("desktop:browser-pane:claim", (_event, contextId, claimantId, bounds, initialUrl, presentation, profileScope) =>
    requireBrowserPaneController().claim(
      String(contextId),
      String(claimantId),
      bounds as BrowserSurfaceBounds,
      typeof initialUrl === "string" && initialUrl ? initialUrl : undefined,
      presentation === undefined ? "visible" : parseBrowserSurfacePresentation(presentation),
      parseBrowserProfileScope(profileScope),
    ),
  );
  registerBridgeHandler("desktop:browser-pane:release", (_event, contextId, claimantId) =>
    requireBrowserPaneController().release(String(contextId), String(claimantId)),
  );
  registerBridgeHandler("desktop:browser-pane:get-state", (_event, contextId) =>
    requireBrowserPaneController().getState(String(contextId)),
  );
  registerBridgeHandler("desktop:browser-pane:open-link", (_event, contextId, url, mode) =>
    requireBrowserPaneController().openLink(...parseBrowserPaneOpenLinkRequest(contextId, url, mode)),
  );
  registerBridgeHandler("desktop:browser-pane:create-tab", (_event, contextId, url) =>
    requireBrowserPaneController().createTab(
      String(contextId),
      typeof url === "string" && url ? url : undefined,
    ),
  );
  registerBridgeHandler("desktop:browser-pane:select-tab", (_event, contextId, tabId) =>
    requireBrowserPaneController().selectTab(String(contextId), String(tabId)),
  );
  registerBridgeHandler("desktop:browser-pane:close-tab", (_event, contextId, tabId) =>
    requireBrowserPaneController().closeTab(String(contextId), String(tabId)),
  );
  registerBridgeHandler("desktop:browser-pane:move-tab", (_event, sourceContextId, tabId, destinationContextId) =>
    requireBrowserPaneController().moveTab(String(sourceContextId), String(tabId), String(destinationContextId)),
  );
  registerBridgeHandler("desktop:browser-pane:navigate", (_event, contextId, tabId, url) =>
    requireBrowserPaneController().navigate(String(contextId), String(tabId), String(url), true),
  );
  registerBridgeHandler("desktop:browser-pane:control", (_event, contextId, tabId, action, options) =>
    requireBrowserPaneController().control(
      String(contextId),
      String(tabId),
      action as BrowserControlAction,
      (options ?? {}) as BrowserControlOptions,
    ),
  );
  registerBridgeHandler("desktop:browser-pane:layout", (_event, contextId, bounds, presentation) =>
    requireBrowserPaneController().layout(
      String(contextId),
      bounds as BrowserSurfaceBounds,
      parseBrowserSurfacePresentation(presentation),
    ),
  );
  registerBridgeHandler("desktop:browser-pane:capture", (_event, contextId, tabId) =>
    requireBrowserPaneController().capture(String(contextId), String(tabId)),
  );
  registerBridgeHandler("desktop:browser-pane:automate", (_event, contextId, tabId, request) =>
    requireBrowserPaneController().automate(
      String(contextId),
      String(tabId),
      request as BrowserAutomationRequest,
    ),
  );
  registerBridgeHandler("desktop:browser-pane:toggle-element-selection", (_event, contextId, tabId, enabled) =>
    requireBrowserPaneController().toggleElementSelection(
      String(contextId),
      String(tabId),
      enabled === true,
    ),
  );
  registerBridgeHandler("desktop:browser-pane:focus", (_event, contextId) =>
    requireBrowserPaneController().focus(String(contextId)),
  );
  registerBridgeHandler("desktop:browser-pane:set-color-scheme", (_event, contextId, colorScheme) =>
    requireBrowserPaneController().setColorScheme(String(contextId), parseBrowserPaneColorScheme(colorScheme)),
  );
  registerBridgeHandler("desktop:browser-pane:set-viewport", (_event, contextId, tabId, viewport) =>
    requireBrowserPaneController().setViewport(
      String(contextId),
      String(tabId),
      parseBrowserPaneViewport(viewport),
    ),
  );
  registerBridgeHandler("desktop:browser-pane:close", (_event, contextId) =>
    requireBrowserPaneController().closeContext(String(contextId)),
  );

  registerBridgeHandler("desktop:artifact-pane:open", (_event, contextId, bounds, url, presentation) =>
    requireArtifactPaneController().open(
      String(contextId),
      bounds as BrowserSurfaceBounds,
      String(url),
      presentation === undefined ? "visible" : parseBrowserSurfacePresentation(presentation),
    ),
  );
  registerBridgeHandler("desktop:artifact-pane:layout", (_event, contextId, bounds, presentation) =>
    requireArtifactPaneController().layout(
      String(contextId),
      bounds as BrowserSurfaceBounds,
      parseBrowserSurfacePresentation(presentation),
    ),
  );
  registerBridgeHandler("desktop:artifact-pane:reload", (_event, contextId, url) =>
    requireArtifactPaneController().reload(
      String(contextId),
      typeof url === "string" && url ? url : undefined,
    ),
  );
  registerBridgeHandler("desktop:artifact-pane:capture", (_event, contextId) =>
    requireArtifactPaneController().capture(String(contextId)),
  );
  registerBridgeHandler("desktop:artifact-pane:automate", (_event, contextId, request) =>
    requireArtifactPaneController().automate(String(contextId), request as BrowserAutomationRequest),
  );
  registerBridgeHandler("desktop:artifact-pane:close", (_event, contextId) =>
    requireArtifactPaneController().close(String(contextId)),
  );

  registerBridgeHandler("desktop:browser-profile:get-settings", () => browserSettingsSnapshot());
  registerBridgeHandler("desktop:browser-profile:update-storage-mode", async (_event, storageMode) => {
    if (storageMode !== "none" && storageMode !== "shared" && storageMode !== "session") {
      throw new Error("browser storage mode is invalid");
    }
    if (!browserProfileSessionService) {
      throw new Error("browser profile service is unavailable");
    }
    await browserProfileSessionService.setStorageMode(storageMode as BrowserStorageMode);
    return browserSettingsSnapshot();
  });
  registerBridgeHandler("desktop:browser-profile:update-preferences", () => browserSettingsSnapshot());
  registerBridgeHandler("desktop:browser-profile:delete-credential", () => false);
  registerBridgeHandler("desktop:browser-profile:fill-credential", () => false);
  registerBridgeHandler("desktop:browser-profile:resolve-credential-prompt", () => null);
  registerBridgeHandler("desktop:browser-profile:clear-download-history", () => browserSettingsSnapshot());
  registerBridgeHandler("desktop:browser-profile:open-downloads", async () => {
    await shell.openPath(app.getPath("downloads"));
  });
  registerBridgeHandler("desktop:browser-profile:list-site-data", async (): Promise<BrowserSiteData[]> =>
    browserProfileSessionService?.listSiteData() ?? [],
  );
  registerBridgeHandler("desktop:browser-profile:clear-site-data", () =>
    browserProfileSessionService?.clearSiteData() ?? false,
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    configureApplicationMenu();
    configureDevelopmentDockIcon();
    configureBrowserWebAuthn(
      app,
      session.defaultSession,
      loadDesktopRuntimeConfig()?.browserWebAuthnKeychainAccessGroup,
    );
    registerShellProtocolClient();
    protocol.handle(SHELL_SCHEME, (request) => serveAppAsset(request.url));
    configureAuth0TokenCors();
    callbackServer = new DesktopAuthCallbackServer({ onFocus: focusMainWindow });
    await callbackServer.start().catch(() => undefined);
    callbackServer.onCallbackReady(() => {
      mainWindow?.webContents.send("desktop:auth:callback-ready");
    });
    desktopUpdater = new DesktopUpdater({
      appIsPackaged: app.isPackaged,
      channel: desktopChannel,
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      autoUpdater,
      onEvent: (event: DesktopUpdateNativeEvent) => {
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.send("desktop:update:event", event);
        }
      },
      beforeRelaunch: async () => {
        await flushBrowserPersistentData();
      },
    });
    autoUpdater.on("before-quit-for-update", () => {
      quitForUpdate = true;
    });
    initializeBrowserProfileStore();
    initializeBrowserPaneSessionStore();
    registerBridgeHandlers();
    mainWindow = createMainWindow();
    attachBrowserPaneController(mainWindow);
    attachArtifactPaneController(mainWindow);

    app.on("activate", () => {
      if (!mainWindow) {
        mainWindow = createMainWindow();
        attachBrowserPaneController(mainWindow);
        attachArtifactPaneController(mainWindow);
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    void callbackServer?.stop();
    browserPaneSessionStore?.flush();
    if (quitPersistenceComplete || quitForUpdate) return;

    event.preventDefault();
    if (quitPersistencePromise) return;
    quitPersistencePromise = flushBrowserPersistentData();
    void quitPersistencePromise.then(() => {
      quitPersistenceComplete = true;
      app.quit();
    });
  });
}
