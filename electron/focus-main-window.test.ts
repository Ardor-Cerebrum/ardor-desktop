import { describe, expect, mock, test } from "bun:test";

import { focusMainWindow, type FocusableApplication, type FocusableWindow } from "./focus-main-window";

function createWindow(overrides: Partial<FocusableWindow> = {}): FocusableWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    restore: mock(() => undefined),
    show: mock(() => undefined),
    focus: mock(() => undefined),
    webContents: { focus: mock(() => undefined) },
    ...overrides,
  };
}

describe("focusMainWindow", () => {
  test("activates the macOS app before focusing its window", () => {
    const calls: string[] = [];
    const application: FocusableApplication = {
      focus: mock((options) => calls.push(`app:${String(options?.steal)}`)),
    };
    const window = createWindow({
      focus: mock(() => calls.push("window")),
      webContents: { focus: mock(() => calls.push("contents")) },
    });

    expect(focusMainWindow(application, window, "darwin")).toBe(true);
    expect(calls).toEqual(["app:true", "window", "contents"]);
  });

  test("restores and shows the window before activating it", () => {
    const calls: string[] = [];
    const application: FocusableApplication = { focus: mock(() => calls.push("app")) };
    const window = createWindow({
      isMinimized: () => true,
      isVisible: () => false,
      restore: mock(() => calls.push("restore")),
      show: mock(() => calls.push("show")),
      focus: mock(() => calls.push("window")),
      webContents: { focus: mock(() => calls.push("contents")) },
    });

    expect(focusMainWindow(application, window, "win32")).toBe(true);
    expect(calls).toEqual(["restore", "show", "app", "window", "contents"]);
  });

  test("does not activate the app when no live window exists", () => {
    const application: FocusableApplication = { focus: mock(() => undefined) };

    expect(focusMainWindow(application, undefined, "darwin")).toBe(false);
    expect(focusMainWindow(application, createWindow({ isDestroyed: () => true }), "darwin")).toBe(false);
    expect(application.focus).not.toHaveBeenCalled();
  });
});
