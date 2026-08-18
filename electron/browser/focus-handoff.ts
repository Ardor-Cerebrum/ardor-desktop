import type { BrowserPaneFocusExitEvent } from "../bridge-contract";

export interface BrowserFocusExitHost {
  isDestroyed(): boolean;
  webContents: {
    focus(): void;
    send(channel: "desktop:browser-pane:focus-exit", event: BrowserPaneFocusExitEvent): void;
  };
}

export function handOffBrowserFocusToChrome(
  window: BrowserFocusExitHost,
  event: BrowserPaneFocusExitEvent,
): boolean {
  if (window.isDestroyed()) return false;
  window.webContents.focus();
  window.webContents.send("desktop:browser-pane:focus-exit", event);
  return true;
}
