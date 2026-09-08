export interface BackgroundTray<Menu = unknown> {
  destroy(): void;
  on(event: "click", listener: () => void): void;
  setContextMenu(menu: Menu): void;
  setToolTip(tooltip: string): void;
}

export interface BackgroundTrayMenuItem {
  click?: () => void;
  label?: string;
  type?: "separator";
}

interface WindowsBackgroundTrayOptions<Menu> {
  appName: string;
  buildMenu(template: BackgroundTrayMenuItem[]): Menu;
  createTray(iconPath: string): BackgroundTray<Menu>;
  iconPath: string;
  onOpen(): void;
  onQuit(): void;
  platform: NodeJS.Platform;
}

export function createWindowsBackgroundTray<Menu>(
  options: WindowsBackgroundTrayOptions<Menu>,
): BackgroundTray<Menu> | undefined {
  if (options.platform !== "win32") {
    return undefined;
  }

  const tray = options.createTray(options.iconPath);
  tray.setToolTip(options.appName);
  tray.setContextMenu(
    options.buildMenu([
      { click: options.onOpen, label: "Open Ardor" },
      { type: "separator" },
      { click: options.onQuit, label: "Quit" },
    ]),
  );
  tray.on("click", options.onOpen);
  return tray;
}
