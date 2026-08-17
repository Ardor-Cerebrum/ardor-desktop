import { describe, expect, mock, test } from "bun:test";

import {
  MAIN_WINDOW_REVEAL_DELAY_MS,
  MAIN_WINDOW_STARTUP_VISIBILITY,
  stageMainWindowReveal,
  type StagedMainWindow,
} from "./main-window-startup";

interface WindowFixture {
  window: StagedMainWindow;
  fireDidFinishLoad(): void;
  setDestroyed(destroyed: boolean): void;
  setOpacity: ReturnType<typeof mock>;
}

function createWindowFixture(): WindowFixture {
  let destroyed = false;
  let didFinishLoad: (() => void) | undefined;
  const setOpacity = mock(() => undefined);
  const window: StagedMainWindow = {
    isDestroyed: () => destroyed,
    setOpacity,
    webContents: {
      once: mock((event: "did-finish-load", listener: () => void) => {
        expect(event).toBe("did-finish-load");
        didFinishLoad = listener;
      }),
    },
  };

  return {
    window,
    fireDidFinishLoad: () => {
      expect(didFinishLoad).toBeDefined();
      didFinishLoad?.();
    },
    setDestroyed: (value) => {
      destroyed = value;
    },
    setOpacity,
  };
}

describe("main window startup", () => {
  test("constructs the window in the compositor while keeping it transparent", () => {
    expect(MAIN_WINDOW_STARTUP_VISIBILITY).toEqual({ opacity: 0, show: true });
  });

  test("reveals a live window 50ms after the shell finishes loading", () => {
    const fixture = createWindowFixture();
    const calls: string[] = [];
    let reveal: (() => void) | undefined;

    stageMainWindowReveal(fixture.window, (task, delayMs) => {
      calls.push(`schedule:${delayMs}`);
      reveal = task;
    });

    expect(calls).toEqual([]);
    expect(fixture.setOpacity).not.toHaveBeenCalled();

    fixture.fireDidFinishLoad();
    expect(calls).toEqual([`schedule:${MAIN_WINDOW_REVEAL_DELAY_MS}`]);
    expect(fixture.setOpacity).not.toHaveBeenCalled();

    expect(reveal).toBeDefined();
    reveal?.();
    expect(fixture.setOpacity).toHaveBeenCalledWith(1);
  });

  test("does not reveal a window destroyed during the delay", () => {
    const fixture = createWindowFixture();
    let reveal: (() => void) | undefined;

    stageMainWindowReveal(fixture.window, (task) => {
      reveal = task;
    });
    fixture.fireDidFinishLoad();
    fixture.setDestroyed(true);
    reveal?.();

    expect(fixture.setOpacity).not.toHaveBeenCalled();
  });
});
