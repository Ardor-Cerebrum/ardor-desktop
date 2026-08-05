export const DESKTOP_WINDOW_TOOLBAR_HEIGHT = 45;

interface WindowsWindowChromeOptions {
  titleBarOverlay: {
    height: number;
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
      height: DESKTOP_WINDOW_TOOLBAR_HEIGHT,
    },
  };
}
