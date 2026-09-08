export interface WindowCloseEvent {
  preventDefault(): void;
}

export interface BackgroundWindow {
  hide(): void;
  on(event: "close", listener: (event: WindowCloseEvent) => void): void;
  removeListener(event: "close", listener: (event: WindowCloseEvent) => void): void;
}

interface BackgroundWindowLifecycleOptions {
  restoreWindow(): boolean;
  window: BackgroundWindow;
}

export interface BackgroundWindowLifecycle {
  dispose(): void;
  markQuitting(): void;
  restore(): boolean;
}

export function createBackgroundWindowLifecycle(
  options: BackgroundWindowLifecycleOptions,
): BackgroundWindowLifecycle {
  let isQuitting = false;
  const handleClose = (event: WindowCloseEvent) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    options.window.hide();
  };
  options.window.on("close", handleClose);

  return {
    dispose: () => options.window.removeListener("close", handleClose),
    markQuitting: () => {
      isQuitting = true;
    },
    restore: options.restoreWindow,
  };
}
