import { describe, expect, test } from "bun:test";

import { resolveMainWindowChrome } from "./window-chrome";

describe("main window chrome", () => {
  test("uses a hidden Windows titlebar with overlay controls", () => {
    expect(resolveMainWindowChrome("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#f8fafc",
        symbolColor: "#334155",
        height: 45,
      },
    });
  });

  test("leaves non-Windows titlebars unchanged", () => {
    expect(resolveMainWindowChrome("darwin")).toEqual({});
    expect(resolveMainWindowChrome("linux")).toEqual({});
  });
});
