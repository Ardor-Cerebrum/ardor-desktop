import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isDesktopBridgeChannel,
  type DesktopBridgeChannel,
  type BrowserPreferences,
  type BrowserPaneSnapshot,
  type BrowserSettingsSnapshot,
  type BrowserSiteData,
  type DesktopAuthCallbackStatus,
  type OpenSidebarBrowserRequest,
  type SidebarBrowserAction,
  type SidebarBrowserAutomationRequest,
  type SidebarBrowserBounds,
  type SidebarBrowserControlOptions,
  type SidebarBrowserInput,
} from "./bridge-contract.js";
import { BrowserController } from "./browser/controller.js";
import { BrowserControllerLifecycle } from "./browser/controller-lifecycle.js";
import { BrowserPaneController } from "./browser/pane-controller.js";
import { createWebContentsBrowserHost } from "./browser/webcontents-host.js";
import { resolveAppAssetPath } from "./app-assets.js";
import { DesktopAuthCallbackServer } from "./auth/callback-server.js";
import { isAuth0AuthorizeUrlAllowed } from "./auth/authorize.js";
import { rewriteAuth0TokenCorsHeaders } from "./auth/cors.js";
import { buildAuth0LogoutUrl } from "./auth/logout.js";
import { getShellProtocolRegistration } from "./auth/protocol.js";
import { parseDesktopRuntimeConfig, resolveDesktopRuntimeConfig, type DesktopRuntimeConfig } from "./auth/runtime-config.js";
import { BrowserProfileStore, type BrowserProfileStorage, type CredentialProtector } from "./browser/profile-store.js";
import { resolveMainWindowChrome } from "./window-chrome.js";

const SHELL_SCHEME = "ardor";
const SHELL_ORIGIN = `${SHELL_SCHEME}://app`;
if (!app.isPackaged) {
  app.setName(process.env.ARDOR_ELECTRON_CHANNEL === "prod" ? "Ardor" : "Ardor Dev");
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
let browserController: BrowserController | undefined;
let browserPaneController: BrowserPaneController | undefined;
let callbackServer: DesktopAuthCallbackServer | undefined;
let browserProfileStore: BrowserProfileStore | undefined;
let desktopRuntimeConfig: DesktopRuntimeConfig | null | undefined;
const desktopInstanceId = randomUUID();
const browserControllerLifecycle = new BrowserControllerLifecycle<BrowserWindow, BrowserController>((window) =>
  createBrowserController(window),
);
let browserPreferences: BrowserPreferences = {
  autofillMode: "ask",
  askToSavePasswords: true,
};

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
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return false;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
  window.webContents.focus();
  return true;
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

function configureBrowserWebAuthn(): void {
  if (process.platform !== "darwin" || typeof app.configureWebAuthn !== "function") {
    return;
  }
  app.configureWebAuthn({
    touchID: {
      keychainAccessGroup: "com.ardor.desktop.browser.webauthn",
    },
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
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
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      browserControllerLifecycle.onClosed(window);
      browserController = undefined;
      browserPaneController?.dispose();
      browserPaneController = undefined;
      mainWindow = undefined;
    }
  });
  void window.loadURL(`${SHELL_ORIGIN}/index.html`);
  return window;
}

function createBrowserController(window: BrowserWindow): BrowserController {
  return new BrowserController(createWebContentsBrowserHost(window), {
    onAddressChanged: (generation, url) => {
      if (!window.isDestroyed()) {
        window.webContents.send("desktop:sidebar-browser:address-changed", { generation, url });
      }
    },
  });
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

function attachBrowserController(window: BrowserWindow): BrowserController {
  const controller = browserControllerLifecycle.attach(window);
  browserController = controller;
  return controller;
}

function attachBrowserPaneController(window: BrowserWindow): BrowserPaneController {
  const controller = new BrowserPaneController(createWebContentsBrowserHost(window), {
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
  browserPreferences = browserProfileStore.snapshot().preferences;
}

function browserSettingsSnapshot(): BrowserSettingsSnapshot {
  return browserProfileStore?.snapshot() ?? {
    passwordStorageSupported: false,
    preferences: { ...browserPreferences },
    credentials: [],
    downloads: [],
  };
}

function requireBrowserController(): BrowserController {
  if (!browserController) {
    throw new Error("browser controller is unavailable");
  }
  return browserController;
}

function requireBrowserPaneController(): BrowserPaneController {
  if (!browserPaneController) {
    throw new Error("browser pane controller is unavailable");
  }
  return browserPaneController;
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

  registerBridgeHandler("desktop:update:check", () => ({ status: "up-to-date" }));
  registerBridgeHandler("desktop:update:install", () => "up-to-date");
  registerBridgeHandler("desktop:update:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  registerBridgeHandler("desktop:sidebar-browser:open", async (_event, request) => {
    if (!request || typeof request !== "object") {
      throw new Error("sidebar browser request is invalid");
    }
    const value = request as OpenSidebarBrowserRequest;
    const opened = await requireBrowserController().open({
      url: value.url,
      source: value.source,
      bounds: value.bounds,
      overlays: value.overlays,
    });
    return {
      generation: opened.generation,
      devtoolsEnabled: process.env.ARDOR_BROWSER_DEVTOOLS === "true",
    };
  });
  registerBridgeHandler("desktop:sidebar-browser:layout", (_event, generation, bounds, visible, overlays) =>
    requireBrowserController().layout(
      generation as number,
      bounds as SidebarBrowserBounds,
      visible as boolean,
      (overlays ?? []) as OpenSidebarBrowserRequest["overlays"],
    ),
  );
  registerBridgeHandler("desktop:sidebar-browser:control", (_event, generation, action, options) => {
    const normalizedAction = action as SidebarBrowserAction;
    if (normalizedAction === "openDevTools" && process.env.ARDOR_BROWSER_DEVTOOLS !== "true") {
      throw new Error("sidebar browser DevTools are disabled");
    }
    return requireBrowserController().controlAsync(
      generation as number,
      normalizedAction,
      (options ?? {}) as SidebarBrowserControlOptions,
    );
  });
  registerBridgeHandler("desktop:sidebar-browser:automate", async (_event, generation, request) =>
    requireBrowserController().automate(generation as number, request as SidebarBrowserAutomationRequest),
  );
  registerBridgeHandler("desktop:sidebar-browser:get-active-tab", () => requireBrowserController().getActiveTab());
  registerBridgeHandler("desktop:sidebar-browser:input", (_event, generation, input) => {
    const accepted = requireBrowserController().input(generation as number, input as SidebarBrowserInput);
    return { accepted, cursor: "default" };
  });
  registerBridgeHandler("desktop:sidebar-browser:close", (_event, generation) =>
    requireBrowserController().close(generation as number),
  );

  registerBridgeHandler("desktop:browser-pane:open", (_event, contextId, bounds, initialUrl) =>
    requireBrowserPaneController().open(
      String(contextId),
      bounds as SidebarBrowserBounds,
      typeof initialUrl === "string" && initialUrl ? initialUrl : undefined,
    ),
  );
  registerBridgeHandler("desktop:browser-pane:get-state", (_event, contextId) =>
    requireBrowserPaneController().getState(String(contextId)),
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
  registerBridgeHandler("desktop:browser-pane:navigate", (_event, contextId, tabId, url) =>
    requireBrowserPaneController().navigate(String(contextId), String(tabId), String(url), true),
  );
  registerBridgeHandler("desktop:browser-pane:control", (_event, contextId, tabId, action, options) =>
    requireBrowserPaneController().control(
      String(contextId),
      String(tabId),
      action as SidebarBrowserAction,
      (options ?? {}) as SidebarBrowserControlOptions,
    ),
  );
  registerBridgeHandler("desktop:browser-pane:layout", (_event, contextId, bounds, visible) =>
    requireBrowserPaneController().layout(String(contextId), bounds as SidebarBrowserBounds, visible === true),
  );
  registerBridgeHandler("desktop:browser-pane:automate", (_event, contextId, tabId, request) =>
    requireBrowserPaneController().automate(
      String(contextId),
      String(tabId),
      request as SidebarBrowserAutomationRequest,
    ),
  );
  registerBridgeHandler("desktop:browser-pane:close", (_event, contextId) =>
    requireBrowserPaneController().closeContext(String(contextId)),
  );

  registerBridgeHandler("desktop:browser-profile:get-settings", () => browserSettingsSnapshot());
  registerBridgeHandler("desktop:browser-profile:update-preferences", (_event, preferences) => {
    if (!preferences || typeof preferences !== "object") {
      throw new Error("browser preferences are invalid");
    }
    const value = preferences as BrowserPreferences;
    if (value.autofillMode !== "ask" && value.autofillMode !== "automatic") {
      throw new Error("browser autofill mode is invalid");
    }
    if (typeof value.askToSavePasswords !== "boolean") {
      throw new Error("browser password preference is invalid");
    }
    browserPreferences = { ...value };
    return browserProfileStore?.updatePreferences(browserPreferences) ?? browserSettingsSnapshot();
  });
  registerBridgeHandler("desktop:browser-profile:delete-credential", (_event, credentialId) => {
    return browserProfileStore?.deleteCredential(String(credentialId)) ?? false;
  });
  registerBridgeHandler("desktop:browser-profile:fill-credential", async (_event, generation, credentialId) => {
    const credential = browserProfileStore?.getCredential(String(credentialId));
    if (!credential) {
      return false;
    }
    return requireBrowserController().fillCredential(generation as number, credential);
  });
  registerBridgeHandler("desktop:browser-profile:resolve-credential-prompt", () => null);
  registerBridgeHandler("desktop:browser-profile:clear-download-history", () => browserSettingsSnapshot());
  registerBridgeHandler("desktop:browser-profile:open-downloads", async () => {
    await shell.openPath(app.getPath("downloads"));
  });
  registerBridgeHandler("desktop:browser-profile:list-site-data", async (): Promise<BrowserSiteData[]> =>
    requireBrowserController().listSiteData(),
  );
  registerBridgeHandler("desktop:browser-profile:clear-site-data", () => requireBrowserController().clearSiteData());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    configureApplicationMenu();
    configureBrowserWebAuthn();
    registerShellProtocolClient();
    protocol.handle(SHELL_SCHEME, (request) => serveAppAsset(request.url));
    configureAuth0TokenCors();
    callbackServer = new DesktopAuthCallbackServer({ onFocus: focusMainWindow });
    await callbackServer.start().catch(() => undefined);
    callbackServer.onCallbackReady(() => {
      mainWindow?.webContents.send("desktop:auth:callback-ready");
    });
    initializeBrowserProfileStore();
    registerBridgeHandlers();
    mainWindow = createMainWindow();
    attachBrowserController(mainWindow);
    attachBrowserPaneController(mainWindow);

    app.on("activate", () => {
      if (!mainWindow) {
        mainWindow = createMainWindow();
        attachBrowserController(mainWindow);
        attachBrowserPaneController(mainWindow);
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    void callbackServer?.stop();
  });
}
