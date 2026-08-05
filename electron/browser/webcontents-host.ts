import { app, shell, WebContentsView, type BrowserWindow } from "electron";

import type {
  BrowserBounds,
  BrowserHost,
  BrowserTabHandle,
} from "./controller";
import type { BrowserSiteData } from "../bridge-contract";

type BrowserInput = {
  kind: string;
  x: number;
  y: number;
  mouseData?: number;
  control?: boolean;
  shift?: boolean;
};

type MouseButton = "left" | "middle" | "right";

const mouseButtonByKind: Record<string, MouseButton> = {
  leftDown: "left",
  leftUp: "left",
  leftDoubleClick: "left",
  rightDown: "right",
  rightUp: "right",
  rightDoubleClick: "right",
  middleDown: "middle",
  middleUp: "middle",
  middleDoubleClick: "middle",
};

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function dispatchInput(webContents: Electron.WebContents, input: BrowserInput): boolean {
  if (input.kind === "focus") {
    webContents.focus();
    return true;
  }
  if (input.kind === "focusNext") {
    webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: input.shift ? ["shift"] : [] });
    webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: input.shift ? ["shift"] : [] });
    return true;
  }
  if (input.kind === "focusPrevious") {
    webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
    webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
    return true;
  }
  if (input.kind === "move" || input.kind === "leave") {
    webContents.sendInputEvent({ type: "mouseMove", x: input.x, y: input.y, movementX: 0, movementY: 0 });
    return true;
  }
  if (input.kind === "wheel" || input.kind === "horizontalWheel") {
    webContents.sendInputEvent({
      type: "mouseWheel",
      x: input.x,
      y: input.y,
      deltaY: input.kind === "wheel" ? input.mouseData ?? 0 : 0,
      deltaX: input.kind === "horizontalWheel" ? input.mouseData ?? 0 : 0,
    });
    return true;
  }

  const button = mouseButtonByKind[input.kind];
  if (button) {
    const type = input.kind.endsWith("Up") ? "mouseUp" : "mouseDown";
    webContents.sendInputEvent({
      type,
      x: input.x,
      y: input.y,
      button,
      clickCount: input.kind.endsWith("DoubleClick") ? 2 : 1,
    });
    return true;
  }
  return false;
}

export function createWebContentsBrowserHost(
  window: BrowserWindow,
  browserPreloadPath?: string,
): BrowserHost {
  return {
    create(tabId: string, partition: string, onUrlChanged?: (url: string) => void): BrowserTabHandle {
      const view = new WebContentsView({
        webPreferences: {
          partition,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
          preload: browserPreloadPath,
        },
      });
      window.contentView.addChildView(view);
      const webContents = view.webContents;
      const notifyUrl = () => onUrlChanged?.(webContents.getURL());
      webContents.on("did-navigate", notifyUrl);
      webContents.on("did-navigate-in-page", notifyUrl);

      const handle: BrowserTabHandle = {
        load: (url) => webContents.loadURL(url),
        url: () => webContents.getURL(),
        setBounds: (bounds: BrowserBounds) => view.setBounds(bounds),
        setVisible: (visible: boolean) => view.setVisible(visible),
        close: () => {
          webContents.removeListener("did-navigate", notifyUrl);
          webContents.removeListener("did-navigate-in-page", notifyUrl);
          if (!webContents.isDestroyed()) {
            window.contentView.removeChildView(view);
            const destroyable = webContents as Electron.WebContents & { destroy?: () => void };
            destroyable.destroy?.();
          }
        },
        sendCommand: async (method, params) => {
          if (!webContents.debugger.isAttached()) {
            webContents.debugger.attach("1.3");
          }
          return webContents.debugger.sendCommand(method, params);
        },
        goBack: () => webContents.canGoBack() && (webContents.goBack(), true),
        goForward: () => webContents.canGoForward() && (webContents.goForward(), true),
        reload: () => (webContents.reload(), true),
        stop: () => (webContents.stop(), true),
        find: (query, forward, findNext) => {
          webContents.findInPage(query, { forward, findNext });
          return true;
        },
        stopFind: () => (webContents.stopFindInPage("clearSelection"), true),
        setZoom: (zoomFactor) => webContents.setZoomFactor(Math.min(5, Math.max(0.25, zoomFactor))),
        clearBrowsingData: async () => {
          await webContents.session.clearStorageData();
          return true;
        },
        openDownloads: async () => {
          await shell.openPath(app.getPath("downloads"));
          return true;
        },
        openExternal: async (url) => {
          if (!isWebUrl(url)) return false;
          await shell.openExternal(url);
          return true;
        },
        openDevTools: () => (webContents.openDevTools({ mode: "detach" }), true),
        print: () =>
          new Promise((resolve) => {
            webContents.print({ silent: false }, (success) => resolve(success));
          }),
        input: (input) => dispatchInput(webContents, input as BrowserInput),
        fillCredential: async (username, password) => {
          const usernameJson = JSON.stringify(username);
          const passwordJson = JSON.stringify(password);
          const result = await webContents.executeJavaScript(
            `(() => {
              const username = ${usernameJson};
              const password = ${passwordJson};
              const passwordInput = document.querySelector('input[type="password"]');
              if (!(passwordInput instanceof HTMLInputElement)) return false;
              const usernameInput = document.querySelector('input[type="email"], input[name*="user" i], input[name*="email" i]');
              const setValue = (element, value) => {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                setter?.call(element, value);
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
              };
              if (usernameInput instanceof HTMLInputElement) setValue(usernameInput, username);
              setValue(passwordInput, password);
              return true;
            })()`,
            true,
          );
          return result === true;
        },
        listSiteData: async (): Promise<BrowserSiteData[]> => {
          const cookies = await webContents.session.cookies.get({});
          const counts = new Map<string, number>();
          for (const cookie of cookies) {
            const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
            if (!domain) {
              continue;
            }
            counts.set(domain, (counts.get(domain) ?? 0) + 1);
          }
          return [...counts.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([domain, cookieCount]) => ({ domain, cookieCount }));
        },
        clearSiteData: async () => {
          await webContents.session.clearStorageData();
          return true;
        },
      };

      // Keep the id in the closure for diagnostics without exposing it to page code.
      void tabId;
      return handle;
    },
  };
}
