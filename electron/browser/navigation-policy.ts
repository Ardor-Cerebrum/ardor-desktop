import { isPublicBrowserUrl } from "./security";

export interface BrowserNavigationEvent {
  preventDefault(): void;
}
export interface BrowserNavigationContents {
  on(
    event: "will-navigate" | "will-redirect",
    listener: (event: BrowserNavigationEvent, url: string) => void,
  ): void;
  setWindowOpenHandler(handler: (details: unknown) => { action: "deny" }): void;
}

function preventUnsafeNavigation(event: BrowserNavigationEvent, url: string): void {
  if (!isPublicBrowserUrl(url)) {
    event.preventDefault();
  }
}

export function installBrowserNavigationPolicy(webContents: BrowserNavigationContents): void {
  webContents.on("will-navigate", preventUnsafeNavigation);
  webContents.on("will-redirect", preventUnsafeNavigation);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
