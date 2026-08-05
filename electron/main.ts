import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isDesktopBridgeChannel,
  type DesktopBridgeChannel,
  type FeatureStatus,
} from "./bridge-contract.js";

const SHELL_SCHEME = "ardor";
const SHELL_ORIGIN = `${SHELL_SCHEME}://app`;
const UNAVAILABLE: FeatureStatus = Object.freeze({ state: "unavailable" });

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
  if (typeof value !== "string") {
    return false;
  }

  const authDomain = process.env.ARDOR_AUTH0_DOMAIN;
  if (!authDomain) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === authDomain && url.pathname === "/authorize";
  } catch {
    return false;
  }
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
  return resolve(configured ?? resolve(app.getAppPath(), "..", "solutions-ui", "dist"));
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
      mainWindow = undefined;
    }
  });
  void window.loadURL(`${SHELL_ORIGIN}/index.html`);
  return window;
}

function registerBridgeHandlers(): void {
  registerBridgeHandler("desktop:runtime:get-info", () => ({
    platform: process.platform,
    shellVersion: app.getVersion(),
  }));
  registerBridgeHandler("desktop:auth:get-status", () => UNAVAILABLE);
  registerBridgeHandler("desktop:auth:open-url", async (_event, value) => {
    if (!authUrlIsAllowed(value)) {
      return false;
    }

    await shell.openExternal(value);
    return true;
  });
  registerBridgeHandler("desktop:update:get-status", () => UNAVAILABLE);
  registerBridgeHandler("desktop:update:check", () => UNAVAILABLE);
  registerBridgeHandler("desktop:browser:get-status", () => UNAVAILABLE);
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

  app.whenReady().then(() => {
    protocol.handle(SHELL_SCHEME, (request) => serveAppAsset(request.url));
    registerBridgeHandlers();
    mainWindow = createMainWindow();

    app.on("activate", () => {
      if (!mainWindow) mainWindow = createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
