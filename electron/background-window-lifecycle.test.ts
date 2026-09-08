import { describe, expect, mock, test } from "bun:test";

import {
  createBackgroundWindowLifecycle,
  type BackgroundWindow,
  type WindowCloseEvent,
} from "./background-window-lifecycle";

function createHarness() {
  let closeListener: ((event: WindowCloseEvent) => void) | undefined;
  const hide = mock(() => undefined);
  const removeListener = mock(
    (_event: "close", listener: (event: WindowCloseEvent) => void) => {
      if (closeListener === listener) {
        closeListener = undefined;
      }
    },
  );
  const window: BackgroundWindow = {
    hide,
    on: mock((_event, listener) => {
      closeListener = listener;
    }),
    removeListener,
  };
  const restoreWindow = mock(() => true);
  const lifecycle = createBackgroundWindowLifecycle({ restoreWindow, window });
  const close = () => {
    const event = { preventDefault: mock(() => undefined) };
    closeListener?.(event);
    return event;
  };

  return { close, hide, lifecycle, removeListener, restoreWindow };
}

describe("background window lifecycle", () => {
  test("prevents ordinary close and hides without running shutdown work", () => {
    const harness = createHarness();

    const event = harness.close();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.hide).toHaveBeenCalledTimes(1);
  });

  test("allows close through after explicit quit begins", () => {
    const harness = createHarness();
    harness.lifecycle.markQuitting();

    const event = harness.close();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(harness.hide).not.toHaveBeenCalled();
  });

  test("restores the existing window through the shared focus path", () => {
    const harness = createHarness();

    expect(harness.lifecycle.restore()).toBe(true);
    expect(harness.restoreWindow).toHaveBeenCalledTimes(1);
  });

  test("removes its only close listener on disposal", () => {
    const harness = createHarness();

    harness.lifecycle.dispose();
    const event = harness.close();

    expect(harness.removeListener).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
