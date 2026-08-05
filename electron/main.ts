import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isDesktopBridgeChannel,
  type DesktopBridgeChannel,
  type BrowserPreferences,
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
import { createWebContentsBrowserHost } from "./browser/webcontents-host.js";
import { DesktopAuthCallbackServer } from "./auth/callback-server.js";
import { isAuth0AuthorizeUrlAllowed } from "./auth/authorize.js";
import { buildAuth0LogoutUrl } from "./auth/logout.js";
import { getShellProtocolRegistration } from "./auth/protocol.js";
import { BrowserProfileStore, type BrowserProfileStorage, type CredentialProtector } from "./browser/profile-store.js";

const SHELL_SCHEME = "ardor";
const SHELL_ORIGIN = `${SHELL_SCHEME}://app`;
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
    },
  },
]);

let mainWindow: BrowserWindow | undefined;
let browserController: BrowserController | undefined;
let callbackServer: DesktopAuthCallbackServer | undefined;
let browserProfileStore: BrowserProfileStore | undefined;
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

function authUrlIsAllowed(value: unknown): value is string {
  const configuredDomain = process.env.ARDOR_AUTH0_DOMAIN ?? process.env.VITE_AUTH0_DOMAIN;
  const clientId = process.env.ARDOR_AUTH0_CLIENT_ID ?? process.env.VITE_AUTH0_CLIENT_ID;
  return isAuth0AuthorizeUrlAllowed(value, { domain: configuredDomain ?? "", clientId });
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

  const root = realpathSync(uiDirectory);
  const candidate = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  const candidateRelativePath = relative(root, candidate);
  if (isAbsolute(candidateRelativePath) || candidateRelativePath.startsWith("..")) {
    return null;
  }

  if (!existsSync(candidate)) {
    return null;
  }

  const resolvedCandidate = realpathSync(candidate);
  const resolvedRelativePath = relative(root, resolvedCandidate);
  if (isAbsolute(resolvedRelativePath) || resolvedRelativePath.startsWith("..")) {
    return null;
  }

  return resolvedCandidate;
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

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
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
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      browserControllerLifecycle.onClosed(window);
      browserController = undefined;
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

function registerBridgeHandlers(): void {
  registerBridgeHandler("desktop:runtime:get-info", () => ({
    platform: process.platform,
    shellVersion: app.getVersion(),
    desktopInstanceId,
  }));

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
    const domain = process.env.ARDOR_AUTH0_DOMAIN ?? process.env.VITE_AUTH0_DOMAIN;
    if (!domain) {
      throw new Error("Auth0 domain is not configured");
    }
    const logoutUrl = buildAuth0LogoutUrl({
      domain,
      allowedDomain: domain,
      clientId: process.env.ARDOR_AUTH0_CLIENT_ID ?? process.env.VITE_AUTH0_CLIENT_ID,
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerShellProtocolClient();
    protocol.handle(SHELL_SCHEME, (request) => serveAppAsset(request.url));
    callbackServer = new DesktopAuthCallbackServer();
    await callbackServer.start().catch(() => undefined);
    callbackServer.onCallbackReady(() => {
      mainWindow?.webContents.send("desktop:auth:callback-ready");
    });
    initializeBrowserProfileStore();
    registerBridgeHandlers();
    mainWindow = createMainWindow();
    attachBrowserController(mainWindow);

    app.on("activate", () => {
      if (!mainWindow) {
        mainWindow = createMainWindow();
        attachBrowserController(mainWindow);
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
