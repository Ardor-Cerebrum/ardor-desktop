import { describe, expect, test } from "bun:test";

import { installBrowserNavigationPolicy } from "./navigation-policy";

type NavigationListener = (event: { preventDefault(): void }, url: string) => void;

describe("browser web contents navigation policy", () => {
  test("allows public HTTPS navigation and blocks unsafe redirects and popups", () => {
    const listeners = new Map<string, NavigationListener>();
    let popupHandler: ((details: unknown) => { action: "deny" }) | undefined;
    const webContents = {
      on(event: string, listener: NavigationListener) {
        listeners.set(event, listener);
      },
      setWindowOpenHandler(handler: (details: unknown) => { action: "deny" }) {
        popupHandler = handler;
      },
    };

    installBrowserNavigationPolicy(webContents);

    let prevented = false;
    listeners.get("will-navigate")?.({ preventDefault: () => { prevented = true; } }, "https://example.com/page");
    expect(prevented).toBe(false);

    listeners.get("will-redirect")?.({ preventDefault: () => { prevented = true; } }, "http://example.com/unsafe");
    expect(prevented).toBe(true);
    expect(popupHandler?.({ url: "https://popup.example" })).toEqual({ action: "deny" });
  });
});
