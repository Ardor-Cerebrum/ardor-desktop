export const DESKTOP_WINDOW_TOOLBAR_HEIGHT = 45;
export const MACOS_TRAFFIC_LIGHT_INSET = 17;

interface MainWindowChromeOptions {
  titleBarOverlay?: { height: number };
  titleBarStyle?: "hidden";
  trafficLightPosition?: { x: number; y: number };
}

export function resolveMainWindowChrome(platform: NodeJS.Platform): MainWindowChromeOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: {
        x: MACOS_TRAFFIC_LIGHT_INSET,
        y: MACOS_TRAFFIC_LIGHT_INSET,
      },
    };
  }

  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        height: DESKTOP_WINDOW_TOOLBAR_HEIGHT,
      },
    };
  }

  return {};
}
