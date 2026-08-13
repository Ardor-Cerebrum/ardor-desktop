import {
  app,
  clipboard,
  Menu,
  nativeTheme,
  net,
  shell,
  View,
  WebContentsView,
  type BrowserWindow,
  type Session,
} from "electron";

import type {
  BrowserBounds,
  BrowserHostCallbacks,
  BrowserPaneHost,
  BrowserPaneSurface,
  BrowserTabHandle,
} from "./controller";
import type { BrowserPaneViewport, BrowserSiteData } from "../bridge-contract";
import {
  FAVICON_FETCH_TIMEOUT_MS,
  createBrowserFaviconRequest,
  fetchBrowserFavicon,
  selectBrowserFaviconCandidate,
} from "./favicon";
import { forceInlinePdfDownload } from "./download-policy";
import { BrowserElementPicker } from "./element-picker";
import { installBrowserNavigationPolicy } from "./navigation-policy";
import { BrowserLoadRetry } from "./load-retry";
import { isBrowserNavigableUrl, isLoopbackBrowserUrl } from "./security";
import { matchBrowserTabShortcut } from "./tab-shortcuts";
import { buildBrowserPageContextMenuTemplate } from "./context-menu";
import { BrowserViewportEmulation } from "./viewport";

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
const downloadStartedByWebContents = new WeakMap<Electron.WebContents, () => void>();
const NATIVE_SURFACE_BORDER_RADIUS = 16;
const EMULATED_VIEWPORT_BORDER_RADIUS = 8;
const SYNTHETIC_INPUT_GRACE_MS = 200;
const USER_ACTIVATION_WINDOW_MS = 5_000;
const requestBrowserFavicon = createBrowserFaviconRequest((options) => net.request(options));

interface NativeBrowserMount {
  add(view: WebContentsView): void;
  remove(view: WebContentsView): void;
  setBounds(view: WebContentsView, bounds: BrowserBounds): void;
  setVisible(view: WebContentsView, visible: boolean): void;
  raise(view: WebContentsView): void;
  applyBaseBackground?(view: WebContentsView): void;
}

interface NativeBrowserTab {
  bounds?: BrowserBounds;
  mount: NativeBrowserMount;
  viewportEmulation?: BrowserViewportEmulation;
  view: WebContentsView;
}

let activePageContextMenu: { menu: Menu; window: BrowserWindow } | undefined;

const detachedBrowserMount: NativeBrowserMount = {
  add: () => undefined,
  remove: () => undefined,
  setBounds: (view, bounds) => view.setBounds(bounds),
  setVisible: (view, visible) => view.setVisible(visible),
  raise: () => undefined,
};

function browserPaneBaseBackground(url: string): string {
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !isLoopbackBrowserUrl(parsed)
    ) {
      return "#ffffff";
    }
  } catch {
    // Originless documents follow the host theme.
  }
  return nativeTheme.shouldUseDarkColors ? "#131312" : "#f5f5f5";
}

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
  browserSession.on("will-download", (_event, _item, webContents) => {
    downloadStartedByWebContents.get(webContents)?.();
  });
  browserSession.webRequest.onHeadersReceived(
    { urls: ["<all_urls>"], types: ["mainFrame"] },
    (details, callback) => {
      const responseHeaders = forceInlinePdfDownload(details.resourceType, details.responseHeaders);
      callback(responseHeaders ? { responseHeaders } : {});
    },
  );
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

function createLegacyMount(window: BrowserWindow): NativeBrowserMount {
  const clipView = new View();
  clipView.setBorderRadius(NATIVE_SURFACE_BORDER_RADIUS);
  return {
    add: (view) => {
      clipView.addChildView(view);
      if (!window.isDestroyed()) window.contentView.addChildView(clipView);
    },
    remove: (view) => {
      clipView.removeChildView(view);
      if (!window.isDestroyed()) window.contentView.removeChildView(clipView);
    },
    setBounds: (view, bounds) => {
      const topExtension = Math.min(NATIVE_SURFACE_BORDER_RADIUS, bounds.y);
      clipView.setBounds({
        x: bounds.x,
        y: bounds.y - topExtension,
        width: bounds.width,
        height: bounds.height + topExtension,
      });
      view.setBounds({ x: 0, y: topExtension, width: bounds.width, height: bounds.height });
    },
    setVisible: (_view, visible) => clipView.setVisible(visible),
    raise: () => {
      if (!window.isDestroyed()) window.contentView.addChildView(clipView);
    },
  };
}

export function createWebContentsBrowserHost(
  window: BrowserWindow,
  browserPreloadPath?: string,
): BrowserPaneHost {
  const nativeTabs = new WeakMap<BrowserTabHandle, NativeBrowserTab>();
  const nativeTabsByView = new WeakMap<WebContentsView, NativeBrowserTab>();
  const pendingPaneMounts = new Map<string, NativeBrowserMount>();
  const pendingPopupTabs = new Map<string, { mount: NativeBrowserMount; view: WebContentsView }>();

  const moveNativeTab = (handle: BrowserTabHandle, mount: NativeBrowserMount): void => {
    const tab = nativeTabs.get(handle);
    if (!tab) {
      throw new Error("browser tab does not belong to this host");
    }
    if (tab.mount === mount) return;
    const previousMount = tab.mount;
    try {
      previousMount.remove(tab.view);
    } catch (error) {
      try {
        previousMount.add(tab.view);
      } catch {
        // Preserve the original mount failure.
      }
      throw error;
    }
    try {
      mount.add(tab.view);
    } catch (error) {
      try {
        previousMount.add(tab.view);
      } catch {
        // Preserve the destination mount failure.
      }
      throw error;
    }
    tab.mount = mount;
  };

  const host: BrowserPaneHost = {
    create(
      tabId: string,
      partition: string,
      onUrlChanged?: (url: string) => void,
      callbacks: BrowserHostCallbacks = {},
    ): BrowserTabHandle {
      const pendingPopup = pendingPopupTabs.get(tabId);
      const view =
        pendingPopup?.view ??
        new WebContentsView({
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
      const paneMount = pendingPaneMounts.get(tabId);
      const mount: NativeBrowserMount = pendingPopup?.mount ?? paneMount ?? createLegacyMount(window);
      mount.add(view);
      const nativeTab: NativeBrowserTab = { mount, view };
      nativeTabsByView.set(view, nativeTab);
      const webContents = view.webContents;
      if (callbacks.constrainVisualZoom) {
        void webContents.setVisualZoomLevelLimits(1, 3).catch(() => undefined);
      }
      if (callbacks.onDownloadStarted) {
        downloadStartedByWebContents.set(webContents, callbacks.onDownloadStarted);
      }
      configureBrowserSessionSecurity(webContents.session, callbacks.isPermissionAllowed);
      const navigationHistory = webContents.navigationHistory;
      installBrowserNavigationPolicy(webContents);
      const enforceContextNavigationPolicy = (event: Electron.Event, url: string) => {
        if (callbacks.isNavigationAllowed && !callbacks.isNavigationAllowed(url)) {
          event.preventDefault();
          try {
            const parsed = new URL(url);
            callbacks.onNavigationBlocked?.(parsed.hostname || parsed.protocol, "policy");
          } catch {
            callbacks.onNavigationBlocked?.(url.split(":", 1)[0] || "unknown destination", "policy");
          }
        }
      };
      const reportBlockedNavigation = (url: string) => {
        if (isBrowserNavigableUrl(url)) return false;
        let reason: "credentials" | "policy" = "policy";
        let hostname = "unknown destination";
        try {
          const parsed = new URL(url);
          hostname = parsed.hostname || parsed.protocol;
          if (parsed.username || parsed.password) reason = "credentials";
        } catch {
          // Malformed and non-web destinations are blocked by policy.
        }
        callbacks.onNavigationBlocked?.(hostname, reason);
        return true;
      };
      const notifyBlockedNavigation = (_event: Electron.Event, url: string) => {
        reportBlockedNavigation(url);
      };
      webContents.on("will-navigate", notifyBlockedNavigation);
      webContents.on("will-redirect", notifyBlockedNavigation);
      webContents.on("will-navigate", enforceContextNavigationPolicy);
      webContents.on("will-redirect", enforceContextNavigationPolicy);
      const notifyState = () => callbacks.onStateChanged?.();
      const loadRetry = new BrowserLoadRetry({
        isDestroyed: () => webContents.isDestroyed(),
        load: (url) => webContents.loadURL(url),
      });
      let loadFailed = false;
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
        nativeTab.mount.applyBaseBackground?.(view);
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
        if (!loadFailed) loadRetry.loaded();
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
      const notifyStarted = () => {
        loadFailed = false;
        notifyState();
      };
      const retryFailedLoad = (
        _event: Electron.Event,
        errorCode: number,
        _errorDescription: string,
        validatedUrl: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame || errorCode === -3 || webContents.isDestroyed()) return;
        loadFailed = true;
        loadRetry.failed(isBrowserNavigableUrl(validatedUrl) ? validatedUrl : undefined);
        notifyState();
      };
      const onFaviconUpdated = (_event: Electron.Event, candidates: string[]) => updateFavicon(candidates);
      let syntheticInputDepth = 0;
      let syntheticInputSuppressedUntil = 0;
      const showPageContextMenu = (_event: Electron.Event, params: Electron.ContextMenuParams) => {
        if (!callbacks.enablePageContextMenu) return;
        if (Date.now() < syntheticInputSuppressedUntil) {
          syntheticInputSuppressedUntil = 0;
          return;
        }
        const template = buildBrowserPageContextMenuTemplate(
          params,
          {
            copyImage: (x, y) => webContents.copyImageAt(x, y),
            copyText: (value) => clipboard.writeText(value),
            inspectElement: (x, y) => {
              webContents.inspectElement(x, y);
              if (webContents.isDevToolsOpened()) webContents.devToolsWebContents?.focus();
            },
            learnSpelling: (word) => webContents.session.addWordToSpellCheckerDictionary(word),
            lookUpSelection: () => webContents.showDefinitionForSelection(),
            openExternal: (url) => void shell.openExternal(url),
            replaceMisspelling: (value) => webContents.replaceMisspelling(value),
          },
          process.env.ARDOR_BROWSER_DEVTOOLS === "true",
        );
        if (template.length === 0 || window.isDestroyed()) return;

        if (activePageContextMenu && !activePageContextMenu.window.isDestroyed()) {
          activePageContextMenu.menu.closePopup(activePageContextMenu.window);
        }
        const menu = Menu.buildFromTemplate(template);
        activePageContextMenu = { menu, window };
        const offset = nativeTab.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
        menu.popup({
          window,
          x: offset.x + params.x,
          y: offset.y + params.y,
          callback: () => {
            if (activePageContextMenu?.menu === menu) activePageContextMenu = undefined;
          },
        });
      };
      webContents.on("did-navigate", notifyCommittedUrl);
      webContents.on("did-navigate-in-page", notifyUrl);
      webContents.on("page-title-updated", notifyState);
      webContents.on("did-start-loading", notifyStarted);
      webContents.on("did-stop-loading", notifyStopped);
      webContents.on("did-fail-load", retryFailedLoad);
      webContents.on("page-favicon-updated", onFaviconUpdated);
      webContents.on("context-menu", showPageContextMenu);
      let lastUserInputAt = callbacks.initialUserActivation ? Date.now() : 0;
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
      const trackUserActivation = (_event: Electron.Event, input: Electron.InputEvent) => {
        if (
          Date.now() >= syntheticInputSuppressedUntil &&
          (input.type === "mouseDown" || input.type === "rawKeyDown" || input.type === "keyDown")
        ) {
          lastUserInputAt = Date.now();
        }
      };
      webContents.on("input-event", trackUserActivation);
      webContents.on("before-input-event", handleShortcut);
      webContents.setWindowOpenHandler(({ url, disposition, features }) => {
        if (reportBlockedNavigation(url)) return { action: "deny" };

        const requestsPopup = disposition === "new-window" || features.length > 0;
        if (!requestsPopup || isLoopbackBrowserUrl(new URL(url))) {
          loadRetry.reset(url);
          void webContents.loadURL(url).catch(() => undefined);
          return { action: "deny" };
        }
        if (Date.now() - lastUserInputAt >= USER_ACTIVATION_WINDOW_MS) return { action: "deny" };

        const adoptPopup = callbacks.onPopupRequested?.({ url, disposition, features });
        if (!adoptPopup) return { action: "deny" };

        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            show: false,
            webPreferences: {
              partition,
              contextIsolation: true,
              sandbox: true,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: false,
              webviewTag: false,
              preload: browserPreloadPath,
            },
          },
          createWindow: (options) => {
            const existingWebContents = (
              options as Electron.BrowserWindowConstructorOptions & { webContents?: Electron.WebContents }
            ).webContents;
            const popupView = new WebContentsView({
              ...(existingWebContents ? { webContents: existingWebContents } : {}),
              webPreferences: options.webPreferences,
            });
            popupView.setVisible(false);
            try {
              const popupHandle = adoptPopup((popupTabId, popupUrlChanged, popupCallbacks = {}) => {
                pendingPopupTabs.set(popupTabId, { mount: nativeTab.mount, view: popupView });
                try {
                  return host.create(popupTabId, partition, popupUrlChanged, {
                    ...popupCallbacks,
                    initialUserActivation: true,
                  });
                } finally {
                  pendingPopupTabs.delete(popupTabId);
                }
              });
              const popupTab = popupHandle ? nativeTabs.get(popupHandle) : undefined;
              if (!popupTab || popupTab.view !== popupView) {
                throw new Error("browser popup was not adopted");
              }
              return popupView.webContents;
            } catch (error) {
              try {
                nativeTab.mount.remove(popupView);
              } catch {
                // Preserve the popup adoption failure.
              }
              if (!popupView.webContents.isDestroyed()) {
                const destroyable = popupView.webContents as Electron.WebContents & { destroy?: () => void };
                destroyable.destroy?.();
              }
              throw error;
            }
          },
        };
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
      const viewportEmulation = new BrowserViewportEmulation(sendDebuggerCommand);
      nativeTab.viewportEmulation = viewportEmulation;
      const sendCommand: BrowserTabHandle["sendCommand"] = async (method, params) => {
        if (!method.startsWith("Input.")) return sendDebuggerCommand(method, params);

        beginSyntheticInput();
        try {
          return await sendDebuggerCommand(method, params);
        } finally {
          endSyntheticInput();
        }
      };

      const elementPicker = new BrowserElementPicker({
        capturePage: (bounds) => webContents.capturePage(bounds),
        isDestroyed: () => webContents.isDestroyed(),
        onSelected: (selection) => callbacks.onElementSelected?.(selection),
        sendCommand: sendDebuggerCommand,
      });
      const handleDebuggerMessage = (_event: Electron.Event, method: string, params: unknown) => {
        elementPicker.handleDebuggerMessage(method, params);
      };
      webContents.debugger.on("message", handleDebuggerMessage);

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

      const handle: BrowserTabHandle = {
        load: (url) => {
          loadRetry.reset(url);
          return webContents.loadURL(url);
        },
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        faviconUrl: () => faviconUrl,
        canGoBack: () => navigationHistory.canGoBack(),
        canGoForward: () => navigationHistory.canGoForward(),
        isLoading: () => webContents.isLoading(),
        setBounds: (bounds) => {
          nativeTab.bounds = bounds;
          nativeTab.mount.setBounds(view, bounds);
        },
        setVisible: (visible) => nativeTab.mount.setVisible(view, visible),
        raise: () => nativeTab.mount.raise(view),
        setBackgroundThrottling: (enabled: boolean) => webContents.setBackgroundThrottling(enabled),
        invalidate: () => webContents.invalidate(),
        capturePage,
        close: () => {
          elementPicker.dispose();
          loadRetry.stop();
          resetFavicon();
          webContents.removeListener("did-navigate", notifyCommittedUrl);
          webContents.removeListener("did-navigate-in-page", notifyUrl);
          webContents.removeListener("page-title-updated", notifyState);
          webContents.removeListener("did-start-loading", notifyStarted);
          webContents.removeListener("did-stop-loading", notifyStopped);
          webContents.removeListener("did-fail-load", retryFailedLoad);
          webContents.removeListener("page-favicon-updated", onFaviconUpdated);
          webContents.removeListener("context-menu", showPageContextMenu);
          webContents.removeListener("input-event", trackUserActivation);
          webContents.removeListener("before-input-event", handleShortcut);
          webContents.removeListener("will-navigate", enforceContextNavigationPolicy);
          webContents.removeListener("will-redirect", enforceContextNavigationPolicy);
          webContents.removeListener("will-navigate", notifyBlockedNavigation);
          webContents.removeListener("will-redirect", notifyBlockedNavigation);
          webContents.debugger.removeListener("message", handleDebuggerMessage);
          downloadStartedByWebContents.delete(webContents);
          nativeTab.mount.remove(view);
          nativeTabs.delete(handle);
          nativeTabsByView.delete(view);
          if (!webContents.isDestroyed()) {
            const destroyable = webContents as Electron.WebContents & { destroy?: () => void };
            destroyable.destroy?.();
          }
        },
        sendCommand,
        setElementSelection: (enabled) => elementPicker.setEnabled(enabled),
        goBack: () => navigationHistory.canGoBack() && (loadRetry.reset(), navigationHistory.goBack(), true),
        goForward: () => navigationHistory.canGoForward() && (loadRetry.reset(), navigationHistory.goForward(), true),
        reload: () => (loadRetry.reset(webContents.getURL()), webContents.reload(), true),
        stop: () => (loadRetry.stop(), webContents.stop(), true),
        find: (query, forward, findNext) => {
          webContents.findInPage(query, { forward, findNext });
          return true;
        },
        stopFind: () => (webContents.stopFindInPage("clearSelection"), true),
        setZoom: (zoomFactor) => webContents.setZoomFactor(Math.min(5, Math.max(0.25, zoomFactor))),
        setViewport: async (viewport: BrowserPaneViewport | null) => {
          const update = viewportEmulation.set(viewport);
          if (viewport === null && nativeTab.bounds) nativeTab.mount.setBounds(view, nativeTab.bounds);
          await update;
          return true;
        },
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
      nativeTabs.set(handle, nativeTab);
      return handle;
    },
    createPaneSurface(_contextId: string): BrowserPaneSurface {
      const container = new View();
      const children = new Set<WebContentsView>();
      let attached = false;
      let disposed = false;
      let topExtension = NATIVE_SURFACE_BORDER_RADIUS;

      container.setBorderRadius(NATIVE_SURFACE_BORDER_RADIUS);
      const applyBaseBackground = (view: WebContentsView) => {
        if (view.webContents.isDestroyed()) return;
        view.setBackgroundColor(browserPaneBaseBackground(view.webContents.getURL()));
      };
      const refreshBaseBackgrounds = () => {
        for (const view of children) applyBaseBackground(view);
      };
      nativeTheme.on("updated", refreshBaseBackgrounds);

      const mount: NativeBrowserMount = {
        add: (view) => {
          if (disposed) throw new Error("browser pane surface is disposed");
          children.add(view);
          applyBaseBackground(view);
          if (attached) container.addChildView(view);
        },
        remove: (view) => {
          if (!children.has(view)) return;
          if (attached) container.removeChildView(view);
          children.delete(view);
        },
        setBounds: (view, bounds) => {
          const nativeTab = nativeTabsByView.get(view);
          if (nativeTab) nativeTab.bounds = bounds;
          const layout = nativeTab?.viewportEmulation?.layout(bounds);
          view.setBounds({
            x: layout?.x ?? 0,
            y: topExtension,
            width: layout?.width ?? bounds.width,
            height: layout?.height ?? bounds.height,
          });
          view.setBorderRadius(layout ? EMULATED_VIEWPORT_BORDER_RADIUS : 0);
        },
        setVisible: (view, visible) => view.setVisible(visible),
        raise: (view) => {
          if (attached && children.has(view)) container.addChildView(view);
        },
        applyBaseBackground,
      };

      const detach = () => {
        if (!attached) return;
        for (const view of children) container.removeChildView(view);
        if (!window.isDestroyed()) window.contentView.removeChildView(container);
        attached = false;
      };

      const surface: BrowserPaneSurface = {
        create: (tabId, partition, onUrlChanged, callbacks = {}) => {
          if (disposed) throw new Error("browser pane surface is disposed");
          pendingPaneMounts.set(tabId, mount);
          try {
            return host.create(tabId, partition, onUrlChanged, callbacks);
          } finally {
            pendingPaneMounts.delete(tabId);
          }
        },
        add: (handle) => moveNativeTab(handle, mount),
        remove: (handle) => moveNativeTab(handle, detachedBrowserMount),
        setBounds: (bounds) => {
          topExtension = Math.min(NATIVE_SURFACE_BORDER_RADIUS, bounds.y);
          container.setBounds({
            x: bounds.x,
            y: bounds.y - topExtension,
            width: bounds.width,
            height: bounds.height + topExtension,
          });
          for (const view of children) mount.setBounds(view, bounds);
        },
        attach: () => {
          if (attached || disposed || window.isDestroyed()) return;
          window.contentView.addChildView(container);
          attached = true;
          for (const view of children) container.addChildView(view);
          refreshBaseBackgrounds();
        },
        detach,
        raise: (handle) => {
          const tab = nativeTabs.get(handle);
          if (!tab || tab.mount !== mount) {
            throw new Error("browser tab does not belong to this pane surface");
          }
          mount.raise(tab.view);
        },
        dispose: () => {
          if (disposed) return;
          detach();
          nativeTheme.removeListener("updated", refreshBaseBackgrounds);
          children.clear();
          disposed = true;
        },
      };

      return surface;
    },
  };

  return host;
}
