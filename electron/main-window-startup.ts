export const MAIN_WINDOW_REVEAL_DELAY_MS = 50;

export const MAIN_WINDOW_STARTUP_VISIBILITY = Object.freeze({
  opacity: 0,
  show: true,
});

export interface StagedMainWindow {
  isDestroyed(): boolean;
  setOpacity(opacity: number): void;
  webContents: {
    once(event: "did-finish-load", listener: () => void): unknown;
  };
}

type RevealScheduler = (task: () => void, delayMs: number) => unknown;

export function stageMainWindowReveal(
  window: StagedMainWindow,
  schedule: RevealScheduler = (task, delayMs) => setTimeout(task, delayMs),
): void {
  window.webContents.once("did-finish-load", () => {
    schedule(() => {
      if (!window.isDestroyed()) {
        window.setOpacity(1);
      }
    }, MAIN_WINDOW_REVEAL_DELAY_MS);
  });
}
