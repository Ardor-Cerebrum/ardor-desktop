export const DESKTOP_WINDOW_TOOLBAR_HEIGHT = 45;

interface WindowsWindowChromeOptions {
  titleBarOverlay: {
    color: string;
    height: number;
    symbolColor: string;
  };
  titleBarStyle: "hidden";
}

export function resolveMainWindowChrome(platform: NodeJS.Platform): WindowsWindowChromeOptions | Record<string, never> {
  if (platform !== "win32") {
    return {};
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f8fafc",
      symbolColor: "#334155",
      height: DESKTOP_WINDOW_TOOLBAR_HEIGHT,
    },
  };
}
