export interface FocusableApplication {
  focus(options?: { steal: boolean }): void;
}

export interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: {
    focus(): void;
  };
}

export function focusMainWindow(
  application: FocusableApplication,
  window: FocusableWindow | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  application.focus(platform === "darwin" ? { steal: true } : undefined);
  window.focus();
  window.webContents.focus();
  return true;
}
