import { app, net, shell, View, WebContentsView, type BrowserWindow, type Session } from "electron";

import type {
  BrowserBounds,
  BrowserHost,
  BrowserHostCallbacks,
  BrowserTabHandle,
} from "./controller";
import type { BrowserSiteData } from "../bridge-contract";
import {
  FAVICON_FETCH_TIMEOUT_MS,
  createBrowserFaviconRequest,
  fetchBrowserFavicon,
  selectBrowserFaviconCandidate,
} from "./favicon";
import { installBrowserNavigationPolicy } from "./navigation-policy";
import { isLoopbackBrowserUrl } from "./security";
import { matchBrowserTabShortcut } from "./tab-shortcuts";

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

const securedSessions = new WeakSet<Session>();
const NATIVE_SURFACE_BORDER_RADIUS = 16;
const SYNTHETIC_INPUT_GRACE_MS = 200;
const requestBrowserFavicon = createBrowserFaviconRequest((options) => net.request(options));

function configureBrowserSessionSecurity(
  browserSession: Session,
  isPermissionAllowed?: (permission: string, requestingUrl: string | undefined) => boolean,
): void {
  if (securedSessions.has(browserSession)) {
    return;
  }
  securedSessions.add(browserSession);
  const hasPermission = (permission: string, requestingUrl: string | undefined) => {
    if (isPermissionAllowed?.(permission, requestingUrl)) {
      return true;
    }
    if (permission !== "clipboard-sanitized-write" || !requestingUrl) {
      return false;
    }
    try {
      return isLoopbackBrowserUrl(new URL(requestingUrl));
    } catch {
      return false;
    }
  };
  browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    hasPermission(permission, requestingOrigin),
  );
  browserSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(hasPermission(permission, details.requestingUrl));
  });
}

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
    create(
      tabId: string,
      partition: string,
      onUrlChanged?: (url: string) => void,
      callbacks: BrowserHostCallbacks = {},
    ): BrowserTabHandle {
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
      const clipView = new View();
      clipView.setBorderRadius(NATIVE_SURFACE_BORDER_RADIUS);
      clipView.addChildView(view);
      window.contentView.addChildView(clipView);
      const webContents = view.webContents;
      configureBrowserSessionSecurity(webContents.session, callbacks.isPermissionAllowed);
      const navigationHistory = webContents.navigationHistory;
      installBrowserNavigationPolicy(webContents);
      const enforceContextNavigationPolicy = (event: Electron.Event, url: string) => {
        if (callbacks.isNavigationAllowed && !callbacks.isNavigationAllowed(url)) {
          event.preventDefault();
        }
      };
      webContents.on("will-navigate", enforceContextNavigationPolicy);
      webContents.on("will-redirect", enforceContextNavigationPolicy);
      const notifyState = () => callbacks.onStateChanged?.();
      let faviconUrl: string | undefined;
      let lastFaviconCandidate: string | undefined;
      let faviconAbort: AbortController | undefined;
      let faviconSequence = 0;
      const resetFavicon = () => {
        faviconUrl = undefined;
        lastFaviconCandidate = undefined;
        faviconAbort?.abort();
        faviconAbort = undefined;
        faviconSequence += 1;
      };
      const notifyUrl = () => {
        onUrlChanged?.(webContents.getURL());
        notifyState();
      };
      const notifyCommittedUrl = () => {
        resetFavicon();
        notifyUrl();
      };
      const updateFavicon = (candidates: readonly string[]) => {
        let documentOrigin: string | undefined;
        try {
          if (!webContents.isDestroyed()) documentOrigin = new URL(webContents.getURL()).origin;
        } catch {
          // A non-URL document has no same-origin favicon allowance.
        }
        const candidate = selectBrowserFaviconCandidate(candidates, documentOrigin);
        const candidateUrl = candidate?.url;
        if (candidateUrl === lastFaviconCandidate) return;

        lastFaviconCandidate = candidateUrl;
        faviconAbort?.abort();
        faviconAbort = undefined;
        const sequence = ++faviconSequence;
        if (!candidate) {
          if (faviconUrl !== undefined) {
            faviconUrl = undefined;
            notifyState();
          }
          return;
        }
        if (candidate.kind === "data") {
          if (candidate.url !== faviconUrl) {
            faviconUrl = candidate.url;
            notifyState();
          }
          return;
        }

        const abort = new AbortController();
        faviconAbort = abort;
        const signal = AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(FAVICON_FETCH_TIMEOUT_MS),
        ]);
        const applyFetchedFavicon = (nextUrl: string | undefined) => {
          if (faviconAbort === abort) faviconAbort = undefined;
          if (webContents.isDestroyed() || faviconSequence !== sequence) return;
          if (nextUrl === undefined && lastFaviconCandidate === candidateUrl) {
            lastFaviconCandidate = undefined;
          }
          if (nextUrl !== faviconUrl) {
            faviconUrl = nextUrl;
            notifyState();
          }
        };
        void fetchBrowserFavicon(
          candidate.url,
          webContents.session,
          signal,
          documentOrigin,
          requestBrowserFavicon,
        ).then(applyFetchedFavicon, () => applyFetchedFavicon(undefined));
      };
      const notifyStopped = () => {
        notifyState();
        if (
          faviconUrl !== undefined ||
          lastFaviconCandidate !== undefined ||
          faviconAbort !== undefined ||
          webContents.isDestroyed()
        ) {
          return;
        }
        try {
          const pageUrl = new URL(webContents.getURL());
          if (pageUrl.protocol === "https:" || pageUrl.protocol === "http:") {
            updateFavicon([`${pageUrl.origin}/favicon.ico`]);
          }
        } catch {
          // A non-URL document has no origin favicon fallback.
        }
      };
      const onFaviconUpdated = (_event: Electron.Event, candidates: string[]) => updateFavicon(candidates);
      webContents.on("did-navigate", notifyCommittedUrl);
      webContents.on("did-navigate-in-page", notifyUrl);
      webContents.on("page-title-updated", notifyState);
      webContents.on("did-start-loading", notifyState);
      webContents.on("did-stop-loading", notifyStopped);
      webContents.on("page-favicon-updated", onFaviconUpdated);
      let syntheticInputDepth = 0;
      let syntheticInputSuppressedUntil = 0;
      const beginSyntheticInput = () => {
        syntheticInputDepth += 1;
        syntheticInputSuppressedUntil = Number.MAX_SAFE_INTEGER;
      };
      const endSyntheticInput = () => {
        syntheticInputDepth -= 1;
        if (syntheticInputDepth === 0) {
          syntheticInputSuppressedUntil = Date.now() + SYNTHETIC_INPUT_GRACE_MS;
        }
      };
      const handleShortcut = (event: Electron.Event, input: Electron.Input) => {
        const shortcut = matchBrowserTabShortcut(
          input,
          process.platform,
          Date.now() < syntheticInputSuppressedUntil,
        );
        if (!shortcut) return;
        event.preventDefault();
        if (shortcut !== "claim") callbacks.onShortcutRequested?.(shortcut);
      };
      webContents.on("before-input-event", handleShortcut);
      webContents.setWindowOpenHandler(({ url }) => {
        if (isWebUrl(url)) {
          callbacks.onOpenRequested?.(url);
        }
        return { action: "deny" };
      });

      const attachDebugger = async () => {
        if (!webContents.debugger.isAttached()) {
          webContents.debugger.attach("1.3");
        }
        await Promise.all([
          webContents.debugger.sendCommand("Runtime.enable"),
          webContents.debugger.sendCommand("Log.enable"),
          webContents.debugger.sendCommand("Network.enable"),
          webContents.debugger.sendCommand("Page.enable"),
        ]);
      };
      void attachDebugger().catch(() => undefined);

      const sendDebuggerCommand = async (method: string, params?: Record<string, unknown>) => {
        await attachDebugger();
        return webContents.debugger.sendCommand(method, params);
      };
      const sendCommand: BrowserTabHandle["sendCommand"] = async (method, params) => {
        if (!method.startsWith("Input.")) return sendDebuggerCommand(method, params);

        beginSyntheticInput();
        try {
          return await sendDebuggerCommand(method, params);
        } finally {
          endSyntheticInput();
        }
      };

      const capturePage = async () => {
        try {
          const image = await webContents.capturePage();
          if (!image.isEmpty()) {
            return image.toDataURL();
          }
        } catch {
          // WebContentsView may not expose a capturable display surface on macOS.
        }
        const response = (await sendCommand("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
        })) as { data?: unknown };
        return typeof response.data === "string" ? `data:image/png;base64,${response.data}` : null;
      };

      const setBounds = (bounds: BrowserBounds) => {
        // Put the rounded top edge behind React chrome so only the page's bottom corners are clipped.
        const topExtension = Math.min(NATIVE_SURFACE_BORDER_RADIUS, bounds.y);
        clipView.setBounds({
          x: bounds.x,
          y: bounds.y - topExtension,
          width: bounds.width,
          height: bounds.height + topExtension,
        });
        view.setBounds({ x: 0, y: topExtension, width: bounds.width, height: bounds.height });
      };

      const handle: BrowserTabHandle = {
        load: (url) => webContents.loadURL(url),
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        faviconUrl: () => faviconUrl,
        canGoBack: () => navigationHistory.canGoBack(),
        canGoForward: () => navigationHistory.canGoForward(),
        isLoading: () => webContents.isLoading(),
        setBounds,
        setVisible: (visible: boolean) => clipView.setVisible(visible),
        setBackgroundThrottling: (enabled: boolean) => webContents.setBackgroundThrottling(enabled),
        invalidate: () => webContents.invalidate(),
        capturePage,
        close: () => {
          resetFavicon();
          webContents.removeListener("did-navigate", notifyCommittedUrl);
          webContents.removeListener("did-navigate-in-page", notifyUrl);
          webContents.removeListener("page-title-updated", notifyState);
          webContents.removeListener("did-start-loading", notifyState);
          webContents.removeListener("did-stop-loading", notifyStopped);
          webContents.removeListener("page-favicon-updated", onFaviconUpdated);
          webContents.removeListener("before-input-event", handleShortcut);
          webContents.removeListener("will-navigate", enforceContextNavigationPolicy);
          webContents.removeListener("will-redirect", enforceContextNavigationPolicy);
          if (!webContents.isDestroyed()) {
            if (!window.isDestroyed()) {
              window.contentView.removeChildView(clipView);
            }
            const destroyable = webContents as Electron.WebContents & { destroy?: () => void };
            destroyable.destroy?.();
          }
        },
        sendCommand,
        goBack: () => navigationHistory.canGoBack() && (navigationHistory.goBack(), true),
        goForward: () => navigationHistory.canGoForward() && (navigationHistory.goForward(), true),
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
        input: (input) => {
          beginSyntheticInput();
          try {
            return dispatchInput(webContents, input as BrowserInput);
          } finally {
            endSyntheticInput();
          }
        },
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
