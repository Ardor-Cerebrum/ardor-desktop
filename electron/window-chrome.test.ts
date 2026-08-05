import { describe, expect, test } from "bun:test";

import { resolveMainWindowChrome } from "./window-chrome";

describe("main window chrome", () => {
  test("uses native Windows colors for overlay controls", () => {
    expect(resolveMainWindowChrome("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        height: 45,
      },
    });
  });

  test("leaves non-Windows titlebars unchanged", () => {
    expect(resolveMainWindowChrome("darwin")).toEqual({});
    expect(resolveMainWindowChrome("linux")).toEqual({});
  });
});
