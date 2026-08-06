interface WindowsWindowChromeOptions {
  titleBarOverlay: true;
  titleBarStyle: "hidden";
}

export function resolveMainWindowChrome(platform: NodeJS.Platform): WindowsWindowChromeOptions | Record<string, never> {
  if (platform !== "win32") {
    return {};
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: true,
  };
}
